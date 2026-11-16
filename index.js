const express = require('express');
const line = require('@line/bot-sdk');
const Jimp = require('jimp');

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

// 🖼️ 優化 1：圖片自動縮放與壓縮（大幅降低上傳時間與 AI 伺服器負擔）
async function compressImage(buffer) {
  try {
    const image = await Jimp.read(buffer);
    // 如果圖片寬度超過 1024px，等比例縮小至 1024px（文字依然非常清晰）
    if (image.bitmap.width > 1024) {
      image.resize(1024, Jimp.AUTO);
    }
    // 轉為 JPEG 並設定品質為 80%
    return await image.quality(80).getBufferAsync(Jimp.MIME_JPEG);
  } catch (err) {
    console.warn('⚠️ 圖片壓縮失敗，改用原圖傳送:', err.message);
    return buffer;
  }
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

// 🚀 優化 2 & 3：極簡高速 Prompt + 多模型自動輪替備援
async function callGeminiOptimized(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY！');

  // 優化 3：設定多個模型端點，若第一個塞車或過載，自動無縫切換下一個！
  const models = [
    'gemini-3.8-flash',
    'gemini-flash-latest'
  ];

  // 優化 2：極簡化 Prompt，減少 AI 思考延遲
  const prompt = `提取菜單餐點與價格。大小份請拆開寫如「品項(小)」。非菜單回傳{"isMenu":false,"items":[]}。只回傳純JSON：{"isMenu":true,"items":[{"name":"品項","price":數字}]}`;

  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18000); // 單一模型最多等 18 秒

    try {
      console.log(`⏳ 嘗試使用模型 [${model}] 解析菜單...`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: base64Image } }
            ]
          }],
          // 強制要求 Gemini 輸出純 JSON 格式，避免多餘廢話與解析錯誤
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();
      if (data.error) throw new Error(`${model} 錯誤: ${data.error.message}`);
      if (!data.candidates || data.candidates.length === 0) throw new Error(`${model} 未回傳內容`);

      const text = data.candidates[0].content.parts[0].text;
      const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      console.log(`✅ 模型 [${model}] 解析成功！`);
      return JSON.parse(cleanText);

    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`⚠️ 模型 [${model}] 失敗 (${err.message})，準備切換備援模型...`);
      lastError = err;
    }
  }

  throw lastError || new Error('所有 AI 模型皆無法回應');
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
      console.log('🖼️ 偵測到圖片訊息，開始抓取與壓縮...');
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 收到菜單！正在自動壓縮並呼叫 AI 高速解析中...'
      });

      const rawBuffer = await getImageBuffer(event.message.id);
      const compressedBuffer = await compressImage(rawBuffer);
      console.log(`📦 圖片處理完成：原圖 ${rawBuffer.length} bytes ➔ 壓縮後 ${compressedBuffer.length} bytes`);

      const base64Image = compressedBuffer.toString('base64');
      const parsed = await callGeminiOptimized(base64Image);

      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) {
        return client.pushMessage(groupId, {
          type: 'text',
          text: '⚠️ AI 找不到清晰的品項與價格！請確認圖片是否清晰，或輸入「開單」手動點餐。'
        });
      }

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items.map(i => `• ${i.name} $${i.price}`).join('\n');
      return client.pushMessage(groupId, {
        type: 'text',
        text: `📋 菜單辨識成功！\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項」\n👉 查看統計：「統計」｜結束：「結單」`
      });
    } catch (err) {
      console.error('❌ AI 辨識最終失敗，自動降級為手動模式:', err.message);
      state.isOrdering = true;
      state.menu = [];
      state.orders = [];

      return client.pushMessage(groupId, {
        type: 'text',
        text: `⚠️ 目前 Google AI 伺服器尖峰過載，無法自動辨識。\n\n📢 已自動為您開啟「手動點餐」模式！\n請直接輸入：「+1 品項 價格」（例如：+1 雞腿飯 100）`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const rawText = event.message.text.trim();
  const lowerText = rawText.toLowerCase();

  // 👋 回覆哈囉 / hi
  if (lowerText === '哈囉' || lowerText === 'hi' || lowerText === 'hello') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '哈囉！我是你的點餐小幫手 🤖\n\n📌 使用方式：\n1. 直接傳送「菜單照片」自動辨識開單\n2. 輸入「開單」手動自由點餐\n3. 輸入「+1 品項」點餐、「取消」刪單\n4. 輸入「統計」看目前明細、「結單」算總帳！'
    });
  }

  // 📢 開單指令
  if (rawText === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📢 已開啟自由點餐！\n請大家直接輸入：「+1 品項 價格」（例如：+1 滷肉飯 50）'
    });
  }

  // ➕ 點餐指令
  if (rawText.startsWith('+1')) {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '⚠️ 目前尚未開單喔！請先傳送「菜單照片」或輸入「開單」。'
      });
    }
    const orderContent = rawText.replace(/^\+1\s*/, '').trim();
    if (!orderContent) return;

    const userName = await getUserName(event);
    let matchedPrice = 0;
    let cleanItemName = orderContent;

    const priceMatch = orderContent.match(/\s+(\d+)$/);
    if (priceMatch) {
      matchedPrice = parseInt(priceMatch[1], 10);
      cleanItemName = orderContent.replace(/\s+\d+$/, '').trim();
    } else if (state.menu.length > 0) {
      const sortedMenu = [...state.menu].sort((a, b) => b.name.length - a.name.length);
      const found = sortedMenu.find(m => orderContent.includes(m.name));
      if (found) matchedPrice = found.price;
    }

    state.orders.push({ userId: event.source.userId, userName, item: cleanItemName, price: matchedPrice });
    const priceHint = matchedPrice > 0 ? ` ($${matchedPrice})` : '';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已登記：${userName} ➔ ${cleanItemName}${priceHint}`
    });
  }

  // 🗑️ 取消點餐
  if (rawText === '取消') {
    if (!state.isOrdering || state.orders.length === 0) return;
    const userId = event.source.userId;
    const idx = state.orders.map(o => o.userId).lastIndexOf(userId);
    if (idx === -1) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 你目前沒有點餐紀錄可以取消喔！' });
    }
    const removed = state.orders.splice(idx, 1)[0];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🗑️ 已取消 ${removed.userName} 的「${removed.item}」`
    });
  }

  // 📊 統計 / 目前訂單
  if (rawText === '統計' || rawText === '目前訂單') {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前沒有進行中的訂單。' });
    }
    if (state.orders.length === 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '📭 目前還沒有人點餐喔！' });
    }

    const summary = {};
    let totalAmount = 0;
    state.orders.forEach(o => {
      const key = o.price > 0 ? `${o.item} ($${o.price})` : o.item;
      summary[key] = (summary[key] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryLines = Object.entries(summary).map(([item, count]) => `• ${item} x ${count}`).join('\n');
    const detailLines = state.orders.map(o => `- ${o.userName}：${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`).join('\n');

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📊 【目前點餐統計】\n\n📦 品項彙整：\n${summaryLines}\n\n👤 個人明細：\n${detailLines}\n\n💰 目前總金額：$${totalAmount}`
    });
  }

  // 🏁 結單
  if (rawText === '結單') {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前沒有進行中的訂單可以結單。' });
    }
    if (state.orders.length === 0) {
      state.isOrdering = false;
      return client.replyMessage(event.replyToken, { type: 'text', text: '🏁 訂單已結束（無人點餐）。' });
    }

    const summary = {};
    let totalAmount = 0;
    state.orders.forEach(o => {
      const key = o.price > 0 ? `${o.item} ($${o.price})` : o.item;
      summary[key] = (summary[key] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryLines = Object.entries(summary).map(([item, count]) => `• ${item} x ${count}`).join('\n');
    const detailLines = state.orders.map(o => `- ${o.userName}：${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`).join('\n');

    state.isOrdering = false;
    state.menu = [];
    state.orders = [];

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🏁 【最終結單明細】\n\n📦 店家叫餐清單：\n${summaryLines}\n\n👤 群友付款明細：\n${detailLines}\n\n💰 總計金額：$${totalAmount}\n\n感謝大家使用！下次點餐請再傳菜單或輸入「開單」～`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
