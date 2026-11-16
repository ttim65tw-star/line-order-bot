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
  console.log('📌 收到 LINE 請求事件:', JSON.stringify(req.body.events));

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

// 🚀 帶有逾時防護的 Gemini 呼叫
async function recognizeMenuWithGemini(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY！');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

  const prompt = `你是一個專業的台灣餐廳菜單解析專家。請分析這張圖片，找出所有餐點與價格。
規則：
1. 若同品項有大小份，請拆成「品項名稱(小)」與「品項名稱(大)」。
2. 若非菜單，回傳：{"isMenu": false, "items": []}
3. 嚴格只回傳純 JSON 格式，不要任何 markdown 標記：
{"isMenu": true, "items": [{"name": "品項名稱", "price": 價格數字}]}`;

  console.log('⏳ 正在對 Gemini 發送請求...');
  
  // 設定 15 秒逾時保護
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
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
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    console.log('📥 Gemini 回傳原始資料:', JSON.stringify(data));

    if (data.error) throw new Error(`Gemini API 錯誤: ${data.error.message}`);
    if (!data.candidates || data.candidates.length === 0) throw new Error('Gemini 未回傳內容');

    const text = data.candidates[0].content.parts[0].text;
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Gemini API 回應逾時（超過 15 秒）');
    }
    throw err;
  }
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.userId;
  if (!groupStates[groupId]) {
    groupStates[groupId] = { isOrdering: false, menu: [], orders: [] };
  }
  const state = groupStates[groupId];

  if (event.message.type === 'image') {
    try {
      console.log('🖼️ 偵測到圖片訊息，開始抓取圖片...');
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 收到圖片，正在解析中...'
      });

      const imageBuffer = await getImageBuffer(event.message.id);
      console.log(`📦 圖片下載成功，大小: ${imageBuffer.length} bytes，送往 Gemini...`);

      const base64Image = imageBuffer.toString('base64');
      const parsed = await recognizeMenuWithGemini(base64Image);
      console.log('🤖 AI 解析結果成功:', JSON.stringify(parsed));

      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) {
        return client.pushMessage(groupId, {
          type: 'text',
          text: '⚠️ AI 找不到清晰的品項與價格！'
        });
      }

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items.map(i => `• ${i.name} $${i.price}`).join('\n');
      return client.pushMessage(groupId, {
        type: 'text',
        text: `📋 菜單辨識成功！\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項」`
      });
    } catch (err) {
      console.error('❌ 圖片處理發生例外錯誤:', err);
      return client.pushMessage(groupId, {
        type: 'text',
        text: `❌ 發生錯誤：${err.message}`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const text = event.message.text.trim();

  if (text === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, { type: 'text', text: '📢 已開啟自由點餐！請輸入：「+1 品項 價格」' });
  }

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
    return client.replyMessage(event.replyToken, { type: 'text', text: `✅ 已登記：${userName} ➔ ${orderContent}${priceHint}` });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
