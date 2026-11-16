const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

const groupStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200);
  Promise.all(req.body.events.map(handleEvent)).catch((err) => {
    console.error('Event error:', err);
  });
});

function getImageBuffer(messageId) {
  return new Promise((resolve, reject) => {
    client.getMessageContent(messageId)
      .then((stream) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', (err) => reject(err));
      })
      .catch(reject);
  });
}

async function getUserName(event) {
  const userId = event.source.userId;
  if (!userId) return '群友';
  try {
    if (event.source.groupId) {
      const profile = await client.getGroupMemberProfile(event.source.groupId, userId);
      return profile.displayName;
    } else {
      const profile = await client.getProfile(userId);
      return profile.displayName;
    }
  } catch (err) {
    return '群友';
  }
}

// 透過 fetch 直接呼叫 Gemini API 辨識圖片
async function recognizeMenuWithGemini(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const prompt = `你是一個精準的菜單辨識助手。請辨識這張圖片中的所有餐點品項與價格。
如果這不是菜單，請只回傳：{"isMenu": false}。
如果是菜單，請嚴格以純 JSON 格式回傳（不要包含 \`\`\`json 標記），格式如下：
{"isMenu": true, "items": [{"name": "品項名稱", "price": 價格數字}]}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: base64Image } }
        ]
      }]
    })
  });

  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleanText);
}

async function handleEvent(event) {
  if (event.type === 'join') {
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '大家好！我是 AI 點餐助手 🍱\n傳送【菜單照片】給我，我會自動幫大家開單統計喔！'
      });
    } catch (err) {
      console.error(err);
    }
    return;
  }

  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.userId;
  if (!groupStates[groupId]) {
    groupStates[groupId] = { isOrdering: false, menu: [], orders: [] };
  }
  const state = groupStates[groupId];

  if (event.message.type === 'image') {
    try {
      const imageBuffer = await getImageBuffer(event.message.id);
      const base64Image = imageBuffer.toString('base64');
      const parsed = await recognizeMenuWithGemini(base64Image);

      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) return;

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items.map(i => `• ${i.name} $${i.price}`).join('\n');

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📋 菜單辨識完成，已開啟點餐！\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項名稱」\n👉 查看明細請打：「統計」\n👉 結束請打：「結單」`
      });
    } catch (err) {
      console.error('AI Error:', err);
      return;
    }
  }

  if (event.message.type !== 'text') return;
  const text = event.message.text.trim();

  if (text === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📢 已開啟自由點餐！請輸入：「+1 品項 價格」，輸入「統計」看明細，輸入「結單」結束。'
    });
  }

  if (text === '哈囉' || text === 'hi') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '你好！傳送菜單照片或輸入「開單」即可開始點餐！'
    });
  }

  if (!state.isOrdering) return;

  if (text.startsWith('+1')) {
    const orderContent = text.replace(/^\+1\s*/, '').trim();
    if (!orderContent) return;

    const userName = await getUserName(event);
    let matchedPrice = 0;

    const priceMatch = orderContent.match(/\s+(\d+)$/);
    if (priceMatch) {
      matchedPrice = parseInt(priceMatch[1], 10);
    } else if (state.menu.length > 0) {
      const sortedMenu = [...state.menu].sort((a, b) => b.name.length - a.name.length);
      const found = sortedMenu.find(m => orderContent.includes(m.name));
      if (found) matchedPrice = found.price;
    }

    state.orders.push({ userId: event.source.userId, userName, item: orderContent, price: matchedPrice });
    const priceHint = matchedPrice > 0 ? ` ($${matchedPrice})` : '';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已登記：${userName} ➔ ${orderContent}${priceHint}`
    });
  }

  if (text === '取消') {
    const userId = event.source.userId;
    let lastIndex = -1;
    for (let i = state.orders.length - 1; i >= 0; i--) {
      if (state.orders[i].userId === userId) { lastIndex = i; break; }
    }
    if (lastIndex !== -1) {
      const removed = state.orders.splice(lastIndex, 1)[0];
      return client.replyMessage(event.replyToken, { type: 'text', text: `🗑️ 已取消：【${removed.item}】` });
    } else {
      return client.replyMessage(event.replyToken, { type: 'text', text: '❓ 找不到你的點餐紀錄！' });
    }
  }

  if (text === '統計' || text === '目前訂單' || text === '結單') {
    if (state.orders.length === 0) {
      if (text === '結單') state.isOrdering = false;
      return client.replyMessage(event.replyToken, { type: 'text', text: text === '結單' ? '🛑 本輪無人點餐，已結單。' : '目前尚無點餐紀錄！' });
    }

    const personalList = state.orders.map((o, idx) => `${idx + 1}. ${o.userName}：${o.item} ($${o.price})`).join('\n');
    const itemCounts = {};
    let totalAmount = 0;
    state.orders.forEach(o => {
      itemCounts[o.item] = (itemCounts[o.item] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryList = Object.entries(itemCounts).map(([item, count]) => `• ${item} x ${count}`).join('\n');
    const title = text === '結單' ? '🎉 【最終結單總表】' : '📊 【目前點餐統計】';
    if (text === '結單') state.isOrdering = false;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${title}\n\n【叫餐總表】\n${summaryList}\n\n【個人明細】\n${personalList}\n\n💰 總計：${state.orders.length} 份 / 共 $${totalAmount} 元`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
