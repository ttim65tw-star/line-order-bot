const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenAI } = require('@google/genai');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const app = express();

// 儲存各群組的點餐狀態
// 格式: { isOrdering: boolean, menu: [{ name: string, price: number }], orders: [{ userId: string, userName: string, item: string, price: number }] }
const groupStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  res.sendStatus(200); // 第一時間回覆 200 避免逾時
  Promise.all(req.body.events.map(handleEvent)).catch((err) => {
    console.error('Event processing error:', err);
  });
});

// 取得 LINE 訊息圖片的 Buffer
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

// 取得使用者顯示名稱
async function getUserName(event) {
  const userId = event.source.userId;
  if (!userId) return '神祕客';
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

async function handleEvent(event) {
  // 機器人加入群組自動打招呼
  if (event.type === 'join') {
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '大家好！我是 AI 點餐助手 🍱\n直接傳送【菜單照片】給我，我會自動辨識品項並幫大家開單統計喔！'
      });
    } catch (err) {
      console.error('Join error:', err);
    }
    return;
  }

  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.userId;
  if (!groupStates[groupId]) {
    groupStates[groupId] = { isOrdering: false, menu: [], orders: [] };
  }
  const state = groupStates[groupId];

  // 1. 處理圖片訊息（AI 辨識菜單）
  if (event.message.type === 'image') {
    try {
      const imageBuffer = await getImageBuffer(event.message.id);
      const base64Image = imageBuffer.toString('base64');

      const prompt = `你是一個精準的菜單辨識助手。請辨識這張圖片中的所有餐點品項與價格。
如果這不是菜單（例如風景照、自拍照、迷因圖），請只回傳：{"isMenu": false}。
如果是菜單，請嚴格以純 JSON 格式回傳（不要包含 \`\`\`json 標記），格式如下：
{"isMenu": true, "items": [{"name": "品項名稱", "price": 價格數字}]}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          prompt,
          {
            inlineData: {
              data: base64Image,
              mimeType: 'image/jpeg'
            }
          }
        ]
      });

      const rawText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(rawText);

      // 非菜單圖片直接忽略，避免干擾群組聊天
      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) {
        return;
      }

      // 初始化新一輪點餐
      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items
        .map((item) => `• ${item.name} $${item.price}`)
        .join('\n');

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📋 菜單辨識完成，已開啟點餐！\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項名稱」（可加備註，例如：+1 雞腿飯 不要辣）\n👉 查看目前明細請打：「統計」\n👉 結束點餐請打：「結單」`
      });
    } catch (err) {
      console.error('Image recognition error:', err);
      return;
    }
  }

  // 2. 處理文字訊息
  if (event.message.type !== 'text') return;
  const text = event.message.text.trim();

  // 手動強制開單指令（沒拍菜單也能用）
  if (text === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📢 已開啟自由點餐模式！\n請大家輸入：「+1 品項 價格」（例如：+1 排骨飯 95）\n輸入「統計」看明細，輸入「結單」結束。'
    });
  }

  // 測試指令
  if (text === '哈囉' || text === 'hi') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '你好！直接傳送「菜單照片」或輸入「開單」就可以開始點餐囉！'
    });
  }

  // 以下指令僅在「點餐進行中」才觸發
  if (!state.isOrdering) return;

  // 點餐邏輯：以 +1 開頭
  if (text.startsWith('+1')) {
    const orderContent = text.replace(/^\+1\s*/, '').trim();
    if (!orderContent) return;

    const userName = await getUserName(event);
    let matchedPrice = 0;

    // 檢查使用者是否自己打了價格（例如：+1 滷肉飯 40）
    const priceMatch = orderContent.match(/\s+(\d+)$/);
    if (priceMatch) {
      matchedPrice = parseInt(priceMatch[1], 10);
    } else if (state.menu.length > 0) {
      // 從 AI 辨識的菜單中模糊比對價格（優先比對字數較長的品項避免誤判）
      const sortedMenu = [...state.menu].sort((a, b) => b.name.length - a.name.length);
      const found = sortedMenu.find((m) => orderContent.includes(m.name));
      if (found) {
        matchedPrice = found.price;
      }
    }

    state.orders.push({
      userId: event.source.userId,
      userName,
      item: orderContent,
      price: matchedPrice
    });

    const priceHint = matchedPrice > 0 ? ` ($${matchedPrice})` : ' (未偵測到價格)';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已登記：${userName} ➔ ${orderContent}${priceHint}`
    });
  }

  // 取消自己最後一筆點餐
  if (text === '取消') {
    const userId = event.source.userId;
    // 從最後面往前找該使用者的訂單
    let lastIndex = -1;
    for (let i = state.orders.length - 1; i >= 0; i--) {
      if (state.orders[i].userId === userId) {
        lastIndex = i;
        break;
      }
    }

    if (lastIndex !== -1) {
      const removed = state.orders.splice(lastIndex, 1)[0];
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `🗑️ 已為 ${removed.userName} 取消：【${removed.item}】`
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❓ 目前找不到你的點餐紀錄喔！'
      });
    }
  }

  // 統計與結單邏輯
  if (text === '統計' || text === '目前訂單' || text === '結單') {
    if (state.orders.length === 0) {
      if (text === '結單') state.isOrdering = false;
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: text === '結單' ? '🛑 本輪無人點餐，已直接結單。' : '目前還沒有人點餐喔！'
      });
    }

    // 1. 個人明細整理
    const personalList = state.orders
      .map((o, idx) => `${idx + 1}. ${o.userName}：${o.item} ($${o.price})`)
      .join('\n');

    // 2. 品項數量彙整（方便打電話跟老闆叫餐）
    const itemCounts = {};
    let totalAmount = 0;
    state.orders.forEach((o) => {
      itemCounts[o.item] = (itemCounts[o.item] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryList = Object.entries(itemCounts)
      .map(([item, count]) => `• ${item} x ${count}`)
      .join('\n');

    const title = text === '結單' ? '🎉 【最終結單總表】' : '📊 【目前點餐統計】';
    if (text === '結單') {
      state.isOrdering = false; // 關閉點餐狀態
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${title}\n\n【給店家叫餐用】\n${summaryList}\n\n【個人明細】\n${personalList}\n\n💰 總計：${state.orders.length} 份 / 共 $${totalAmount} 元`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
