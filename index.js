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

async function compressImage(buffer) {
  try {
    const image = await Jimp.read(buffer);
    if (image.bitmap.width > 1024) {
      image.resize(1024, Jimp.AUTO);
    }
    return await image.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  } catch (err) {
    console.warn('⚠️ 圖片壓縮失敗:', err.message);
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

async function callGeminiAdvanced(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY！');

  const models = ['gemini-3.8-flash', 'gemini-flash-latest'];
  const prompt = `你是一個專業的台灣餐廳菜單解析專家。請仔細讀取這張圖片中的所有餐點名稱與對應價格。
【解析規則】：
1. 規格拆解：若同品項有大小份、不同口味，請獨立拆開（例如：「排骨飯(大)」）。
2. 價格必須是純數字，若無價格填 0。
3. 嚴格只回傳合法純 JSON，不要任何 markdown：
{"isMenu": true, "items": [{"name": "品項名稱", "price": 價格數字}]}`;

  let lastError = null;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 22000);

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
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.3 }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();
      if (data.error) throw new Error(`${model} 錯誤: ${data.error.message}`);
      if (!data.candidates || data.candidates.length === 0) throw new Error(`${model} 未回傳內容`);

      const text = data.candidates[0].content.parts[0].text;
      const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanText);
    } catch (err) {
      clearTimeout(timeoutId);
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

  if (event.message.type === 'image') {
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 收到菜單！AI 正在深度掃描與解析品項，請稍候...'
      });

      const rawBuffer = await getImageBuffer(event.message.id);
      const compressedBuffer = await compressImage(rawBuffer);
      const base64Image = compressedBuffer.toString('base64');
      const parsed = await callGeminiAdvanced(base64Image);

      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) {
        return client.pushMessage(groupId, { type: 'text', text: '⚠️ AI 找不到清晰的品項與價格！' });
      }

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items.map(i => `• ${i.name}：$${i.price}`).join('\n');
      return client.pushMessage(groupId, {
        type: 'text',
        text: `📋 **菜單辨識成功！**\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項 [備註/金額]」`
      });
    } catch (err) {
      state.isOrdering = true;
      state.menu = [];
      state.orders = [];
      return client.pushMessage(groupId, {
        type: 'text',
        text: `⚠️ AI 伺服器繁忙，已自動開啟「手動點餐」模式！\n請直接輸入：「+1 品項 價格」（例如：+1 雞腿飯 100 微辣）`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const rawText = event.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (lowerText === '哈囉' || lowerText === 'hi' || lowerText === 'hello') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '哈囉！我是你的點餐小幫手 🤖\n\n📌 使用方式：\n1. 傳送「菜單照片」自動辨識\n2. 輸入「開單」手動點餐\n3. 輸入「+1 品項 價格 (備註)」點餐\n4. 輸入「統計」看明細、輸入「結單」算總帳！'
    });
  }

  if (rawText === '開單') {
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📢 **已開啟自由點餐！**\n請輸入：「+1 品項 價格 備註」（例如：+1 滷肉飯 50 大辣）'
    });
  }

  // ➕ 點餐與備註智慧拆解邏輯
  if (rawText.startsWith('+1')) {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前尚未開單喔！請先傳送菜單或輸入「開單」。' });
    }
    const orderContent = rawText.replace(/^\+1\s*/, '').trim();
    if (!orderContent) return;

    const userName = await getUserName(event);
    let matchedPrice = 0;
    let detectedItem = orderContent;
    let customNote = '';

    // 1. 優先從文字中抓出金額數字 (例如結尾或獨立的數字 $50 / 50)
    const priceRegex = /\s+(\d+)(?:\s|$)/g;
    let match;
    let lastPriceMatch = null;
    while ((match = priceRegex.exec(orderContent)) !== null) {
      lastPriceMatch = match;
    }

    if (lastPriceMatch) {
      matchedPrice = parseInt(lastPriceMatch[1], 10);
      // 把金額從品項字串中抽離
      detectedItem = orderContent.slice(0, lastPriceMatch.index).trim();
      customNote = orderContent.slice(lastPriceMatch.index + lastPriceMatch[0].length).trim();
    } else if (state.menu.length > 0) {
      // 2. 如果使用者沒打價錢，嘗試從 AI 菜單中對應品項名稱與價格
      const sortedMenu = [...state.menu].sort((a, b) => b.name.length - a.name.length);
      const found = sortedMenu.find(m => orderContent.includes(m.name));
      if (found) {
        matchedPrice = found.price;
        detectedItem = found.name;
        // 剩下的字串當作備註
        customNote = orderContent.replace(found.name, '').trim();
      }
    }

    // 清理殘餘符號
    if (!detectedItem) detectedItem = orderContent;

    state.orders.push({
      userId: event.source.userId,
      userName,
      item: detectedItem,
      price: matchedPrice,
      note: customNote
    });

    const priceText = matchedPrice > 0 ? `💰 $${matchedPrice}` : '💰 $0';
    const noteText = customNote ? ` 📝 (${customNote})` : '';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已登記：${userName}\n🍴 ${detectedItem} ${priceText}${noteText}`
    });
  }

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

  // 📊 優化排版：統計 / 目前訂單
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
      const key = `${o.item}${o.price >5 || o.price > 0 ? ` ($${o.price})` : ''}`;
      summary[key] = (summary[key] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryLines = Object.entries(summary).map(([item, count]) => `▫️ ${item} ➔ **${count} 份**`).join('\n');
    const detailLines = state.orders.map(o => {
      const noteStr = o.note ? ` [${o.note}]` : '';
      const priceStr = o.price > 0 ? `($${o.price})` : '';
      return `• ${o.userName}：${o.item} ${priceStr}${noteStr}`;
    }).join('\n');

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📊 ─── 【目前點餐統計】 ───\n\n📦 **【品項彙整】**\n${summaryLines}\n\n👤 **【個人明細】**\n${detailLines}\n\n──────────────────\n💰 **目前總金額：$${totalAmount}**`
    });
  }

  // 🏁 優化排版：結單
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
      const key = `${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`;
      summary[key] = (summary[key] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryLines = Object.entries(summary).map(([item, count]) => `▫️ ${item} ➔ **${count} 份**`).join('\n');
    const detailLines = state.orders.map(o => {
      const noteStr = o.note ? ` [${o.note}]` : '';
      const priceStr = o.price > 0 ? `($${o.price})` : '';
      return `• ${o.userName}：${o.item} ${priceStr}${noteStr}`;
    }).join('\n');

    state.isOrdering = false;
    state.menu = [];
    state.orders = [];

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🏁 ─── 【最終結單明細】 ───\n\n📦 **【店家叫餐清單】**\n${summaryLines}\n\n👤 **【群友付款明細】**\n${detailLines}\n\n──────────────────\n💰 **總計金額：$${totalAmount}**\n\n感謝大家使用！下次點餐請再傳菜單或輸入「開單」～`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
