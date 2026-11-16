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

// 🔄 帶有「自動重試」與「25秒逾時」的 Gemini 請求函式
async function callGeminiWithRetry(base64Image, maxRetries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY！');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

  const prompt = `你是一個專業的台灣餐廳菜單解析專家。請分析這張圖片，找出所有餐點與價格。
規則：
1. 若同品項有大小份，請拆成「品項名稱(小)」與「品項名稱(大)」。
2. 若非菜單，回傳：{"isMenu": false, "items": []}
3. 嚴格只回傳純 JSON 格式，不要任何 markdown 標記：
{"isMenu": true, "items": [{"name": "品項名稱", "price": 價格數字}]}`;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      console.log(`⏳ 正在對 Gemini 發送請求 (嘗試次數 ${attempt}/${maxRetries + 1})...`);
      
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

      if (data.error) {
        throw new Error(`Gemini API 錯誤: ${data.error.message}`);
      }
      if (!data.candidates || data.candidates.length === 0) {
        throw new Error('Gemini 未回傳內容');
      }

      const text = data.candidates[0].content.parts[0].text;
      const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanText);

    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`⚠️ 第 ${attempt} 次嘗試失敗: ${err.message}`);

      if (attempt > maxRetries) {
        throw err;
      }

      console.log('🔄 準備在 2 秒後自動重試...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.userId;
  if (!groupStates[groupId]) {
    groupStates[groupId] = { isOrdering: false, menu: [], orders: [] };
  }
  const state = groupStates[groupId];

  // 🖼️ 處理圖片訊息
  if (event.message.type === 'image') {
    try {
      console.log('🖼️ 偵測到圖片訊息，開始抓取圖片...');
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 收到圖片，AI 正在努力解析中（遇塞車會自動重試）...'
      });

      const imageBuffer = await getImageBuffer(event.message.id);
      console.log(`📦 圖片下載成功，大小: ${imageBuffer.length} bytes`);

      const base64Image = imageBuffer.toString('base64');
      const parsed = await callGeminiWithRetry(base64Image, 2);
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
      console.error('❌ 圖片處理最終失敗:', err);
      return client.pushMessage(groupId, {
        type: 'text',
        text: `❌ AI 伺服器目前過載或回應逾時，已自動重試數次仍失敗。請稍後再試，或輸入「開單」改為手動點餐！`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const text = event.message.text.trim().toLowerCase();

  // 👋 回覆哈囉 / hi
  if (text === '哈囉' || text === 'hi' || text === 'hello') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '哈囉！我是你的點餐小幫手 🤖\n你可以傳送「菜單照片」讓我自動辨識，或是輸入「開單」來手動開始點餐喔！'
    });
  }

  // 📢 開單指令
  if (text === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, { type: 'text', text: '📢 已開啟自由點餐！請輸入：「+1 品項 價格」' });
  }

  // ➕ 點餐指令
  if (text.startsWith('+1')) {
    const orderContent = event.message.text.replace(/^\+1\s*/, '').trim();
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
