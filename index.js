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

// 🏁 共用結單與清空函式（手動結單與定時結單共用）
function generateFinalReceipt(state) {
  const summary = {};
  let totalAmount = 0;

  state.orders.forEach(o => {
    const key = `${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`;
    summary[key] = (summary[key] || 0) + 1;
    totalAmount += o.price;
  });

  const summaryLines = Object.entries(summary)
    .map(([item, count]) => `▫️ ${item} ➔ ${count} 份`)
    .join('\n');

  const detailLines = state.orders
    .map(o => {
      const noteStr = o.note ? ` [${o.note}]` : '';
      const priceStr = o.price > 0 ? ` ($${o.price})` : '';
      return `• ${o.userName}：${o.item}${priceStr}${noteStr}`;
    })
    .join('\n');

  return `🏁 ─── 【最終結單明細】 ───\n\n📦 【店家叫餐清單】\n${summaryLines}\n\n👤 【群友付款明細】\n${detailLines}\n\n──────────────────\n💰 總計金額：$${totalAmount}\n\n感謝大家使用！下次點餐請再傳菜單或輸入「開單」～`;
}

function executeAutoClose(groupId) {
  const state = groupStates[groupId];
  if (!state || !state.isOrdering) return;

  if (state.closeTimer) {
    clearTimeout(state.closeTimer);
    state.closeTimer = null;
  }
  state.closeTimeText = null;

  if (state.orders.length === 0) {
    state.isOrdering = false;
    state.menu = [];
    client.pushMessage(groupId, {
      type: 'text',
      text: '⏰ 結單時間已到！本次無人點餐，系統已自動結束訂單。'
    }).catch(console.error);
    return;
  }

  const receiptText = generateFinalReceipt(state);
  state.isOrdering = false;
  state.menu = [];
  state.orders = [];

  client.pushMessage(groupId, {
    type: 'text',
    text: `⏰ 結單時間已到！系統已自動為您結單：\n\n${receiptText}`
  }).catch(console.error);
}

// 🔍 強化版：模糊比對菜單與分離備註（解決打備註或少打括號導致金額為 0 的問題）
function parseOrderSegment(segment, menu) {
  let matchedPrice = 0;
  let detectedItem = segment;
  let customNote = '';

  // 1. 優先檢查使用者是否自己有打明確數字金額（例如「滷肉飯 50 大辣」或「滷肉飯 大辣 $50」）
  const explicitPriceMatch = segment.match(/(?:^|\s|\$)(\d+)(?:\s|$|元)/);
  if (explicitPriceMatch) {
    matchedPrice = parseInt(explicitPriceMatch[1], 10);
    const withoutPrice = segment.replace(explicitPriceMatch[0], ' ').replace(/\s+/g, ' ').trim();
    
    if (menu && menu.length > 0) {
      const sortedMenu = [...menu].sort((a, b) => b.name.length - a.name.length);
      const found = sortedMenu.find(m => withoutPrice.includes(m.name));
      if (found) {
        detectedItem = found.name;
        customNote = withoutPrice.replace(found.name, '').trim();
        return { item: detectedItem, price: matchedPrice, note: customNote };
      }
    }
    
    // 手動開單沒菜單時，用空白切割第一個詞當品項，後面全部當備註
    const parts = withoutPrice.split(/\s+/);
    detectedItem = parts[0] || withoutPrice;
    customNote = parts.slice(1).join(' ');
    return { item: detectedItem, price: matchedPrice, note: customNote };
  }

  // 2. 使用者沒打金額，從 AI 菜單中進行「完整比對」與「去括號模糊比對」
  if (menu && menu.length > 0) {
    const sortedMenu = [...menu].sort((a, b) => b.name.length - a.name.length);
    
    // 2A. 完整包含比對（例如菜單是「排骨飯(大)」，輸入「排骨飯(大) 加辣」）
    let found = sortedMenu.find(m => segment.includes(m.name));
    if (found) {
      matchedPrice = found.price;
      detectedItem = found.name;
      customNote = segment.replace(found.name, '').trim();
      return { item: detectedItem, price: matchedPrice, note: customNote };
    }

    // 2B. 去括號/符號模糊比對（例如菜單是「排骨飯(大)」，使用者打「排骨飯大 加辣」或只打「排骨飯 加辣」）
    const cleanSegment = segment.replace(/[()（）\-\s]/g, '');
    found = sortedMenu.find(m => {
      const cleanMenuName = m.name.replace(/[()（）\-\s]/g, '');
      return cleanSegment.includes(cleanMenuName);
    });

    if (found) {
      matchedPrice = found.price;
      detectedItem = found.name;
      // 嘗試移除核心字眼抽出備註
      const coreName = found.name.replace(/[()（）].*?[()（）]/g, '').trim();
      customNote = segment.replace(found.name, '').replace(coreName, '').replace(/^[()（）\-\s]+/, '').trim();
      return { item: detectedItem, price: matchedPrice, note: customNote };
    }
  }

  // 3. 找不到對應菜單且沒打金額，將第一個詞當品項，其餘當備註
  const fallbackParts = segment.split(/\s+/);
  detectedItem = fallbackParts[0] || segment;
  customNote = fallbackParts.slice(1).join(' ');
  return { item: detectedItem, price: 0, note: customNote };
}

// ⏰ 解析結單時間指令（支援「30分鐘後結單」與「11:30結單 / 11點半結單」）
function parseCloseTimeCommand(text) {
  // 模式 A：X分鐘後結單 / X分後結單
  const minsMatch = text.match(/^(\d+)\s*分鐘?後?結單$/);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1], 10);
    if (mins > 0 && mins <= 1440) {
      const delayMs = mins * 60 * 1000;
      const targetTaipei = new Date(Date.now() + 8 * 3600 * 1000 + delayMs);
      const hh = String(targetTaipei.getUTCHours()).padStart(2, '0');
      const mm = String(targetTaipei.getUTCMinutes()).padStart(2, '0');
      return { delayMs, displayStr: `${hh}:${mm}（${mins} 分鐘後）` };
    }
  }

  // 模式 B：指定幾點幾分結單（例如：11:30結單、11點30分結單、11點半結單、下午2點結單）
  const timeMatch = text.match(/^(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*[:：點時]\s*(\d{1,2}|半)?\s*分?\s*結單$/);
  if (timeMatch) {
    const period = timeMatch[1] || '';
    let hour = parseInt(timeMatch[2], 10);
    let minute = 0;

    if (timeMatch[3] === '半') {
      minute = 30;
    } else if (timeMatch[3]) {
      minute = parseInt(timeMatch[3], 10);
    }

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if ((period === '下午' || period === '晚上') && hour < 12) {
        hour += 12;
      } else if (period === '中午' && hour < 11) {
        hour += 12;
      }

      // 換算成台灣時間 (UTC+8) 計算距離現在還有幾毫秒
      const nowUtc = Date.now();
      const taipeiOffset = 8 * 3600 * 1000;
      const nowTaipei = new Date(nowUtc + taipeiOffset);

      const targetTaipei = new Date(nowTaipei.getTime());
      targetTaipei.setUTCHours(hour, minute, 0, 0);

      // 如果設定的時間已經過了（例如現在 12:00 喊 11:30 結單），自動推算為明天的該時間
      if (targetTaipei.getTime() <= nowTaipei.getTime()) {
        targetTaipei.setUTCDate(targetTaipei.getUTCDate() + 1);
      }

      const delayMs = targetTaipei.getTime() - nowTaipei.getTime();
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');
      return { delayMs, displayStr: `${hh}:${mm}` };
    }
  }

  return null;
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.userId;
  if (!groupStates[groupId]) {
    groupStates[groupId] = {
      isOrdering: false,
      menu: [],
      orders: [],
      closeTimer: null,
      closeTimeText: null
    };
  }
  const state = groupStates[groupId];

  // 🖼️ 處理圖片訊息
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

      if (state.closeTimer) {
        clearTimeout(state.closeTimer);
        state.closeTimer = null;
        state.closeTimeText = null;
      }

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];

      const menuListText = parsed.items.map(i => `• ${i.name}：$${i.price}`).join('\n');
      return client.pushMessage(groupId, {
        type: 'text',
        text: `📋 菜單辨識成功！\n\n${menuListText}\n\n👉 點餐請輸入：「+1 品項 備註」\n⏰ 可設定自動結單（例如：「11:30結單」或「30分鐘後結單」）`
      });
    } catch (err) {
      if (state.closeTimer) {
        clearTimeout(state.closeTimer);
        state.closeTimer = null;
        state.closeTimeText = null;
      }
      state.isOrdering = true;
      state.menu = [];
      state.orders = [];
      return client.pushMessage(groupId, {
        type: 'text',
        text: `⚠️ AI 伺服器繁忙，已自動開啟「手動點餐」模式！\n請直接輸入：「+1 品項 價格 備註」\n⏰ 可設定自動結單（例如：「11:30結單」或「30分鐘後結單」）`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const rawText = event.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (lowerText === '哈囉' || lowerText === 'hi' || lowerText === 'hello') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '哈囉！我是你的點餐小幫手 🤖\n\n📌 使用方式：\n1. 傳送「菜單照片」自動辨識\n2. 輸入「開單」手動點餐\n3. 輸入「+1 品項 備註」（可一次打多個 +1，金額自動帶入）\n4. 設定定時：「11:30結單」或「30分鐘後結單」\n5. 輸入「統計」看明細、輸入「結單」立刻算總帳！'
    });
  }

  if (rawText === '開單') {
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
      state.closeTimeText = null;
    }
    state.isOrdering = true;
    state.menu = [];
    state.orders = [];
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '📢 已開啟自由點餐！\n請輸入：「+1 品項 價格 備註」（例如：+1 滷肉飯 50 大辣）\n⏰ 可輸入「11:30結單」或「30分鐘後結單」設定自動結單！'
    });
  }

  // ⏰ 設定自動結單時間
  const timeCmd = parseCloseTimeCommand(rawText);
  if (timeCmd) {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '⚠️ 目前尚未開單喔！請先傳送菜單或輸入「開單」後再設定結單時間。'
      });
    }

    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
    }

    state.closeTimeText = timeCmd.displayStr;
    state.closeTimer = setTimeout(() => {
      executeAutoClose(groupId);
    }, timeCmd.delayMs);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `⏰ 已設定自動結單時間：將於 ${timeCmd.displayStr} 準時自動結單並公布明細！`
    });
  }

  // ➕ 支援一人點多個品項 + 智慧模糊比對金額與分離備註
  if (rawText.startsWith('+1') || rawText.includes('+1') || rawText.startsWith('＋1') || rawText.includes('＋1')) {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前尚未開單喔！請先傳送菜單或輸入「開單」。' });
    }

    const userName = await getUserName(event);
    const subSegments = rawText
      .split(/(?=\+1|＋1)/g)
      .map(s => s.replace(/^\+1|＋1/, '').trim())
      .filter(Boolean);

    if (subSegments.length === 0) return;

    const addedResults = [];

    for (const segment of subSegments) {
      const parsedOrder = parseOrderSegment(segment, state.menu);

      state.orders.push({
        userId: event.source.userId,
        userName,
        item: parsedOrder.item,
        price: parsedOrder.price,
        note: parsedOrder.note
      });

      const priceText = parsedOrder.price > 0 ? ` 💰 $${parsedOrder.price}` : ' 💰 $0 (未匹配金額)';
      const noteText = parsedOrder.note ? ` 📝 [${parsedOrder.note}]` : '';
      addedResults.push(`• ${parsedOrder.item}${priceText}${noteText}`);
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已幫 ${userName} 登記：\n${addedResults.join('\n')}`
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

  // 📊 統計 / 目前訂單
  if (rawText === '統計' || rawText === '目前訂單') {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前沒有進行中的訂單。' });
    }
    if (state.orders.length === 0) {
      const timerHint = state.closeTimeText ? `\n⏰ 預計結單時間：${state.closeTimeText}` : '';
      return client.replyMessage(event.replyToken, { type: 'text', text: `📭 目前還沒有人點餐喔！${timerHint}` });
    }

    const summary = {};
    let totalAmount = 0;
    state.orders.forEach(o => {
      const key = `${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`;
      summary[key] = (summary[key] || 0) + 1;
      totalAmount += o.price;
    });

    const summaryLines = Object.entries(summary).map(([item, count]) => `▫️ ${item} ➔ ${count} 份`).join('\n');
    const detailLines = state.orders.map(o => {
      const noteStr = o.note ? ` [${o.note}]` : '';
      const priceStr = o.price > 0 ? ` ($${o.price})` : '';
      return `• ${o.userName}：${o.item}${priceStr}${noteStr}`;
    }).join('\n');

    const timerBanner = state.closeTimeText ? `\n⏰ 預計自動結單：${state.closeTimeText}` : '';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📊 ─── 【目前點餐統計】 ───${timerBanner}\n\n📦 【品項彙整】\n${summaryLines}\n\n👤 【個人明細】\n${detailLines}\n\n──────────────────\n💰 目前總金額：$${totalAmount}`
    });
  }

  // 🏁 立即手動結單
  if (rawText === '結單') {
    if (!state.isOrdering) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 目前沒有進行中的訂單可以結單。' });
    }

    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
      state.closeTimeText = null;
    }

    if (state.orders.length === 0) {
      state.isOrdering = false;
      state.menu = [];
      return client.replyMessage(event.replyToken, { type: 'text', text: '🏁 訂單已結束（無人點餐）。' });
    }

    const receiptText = generateFinalReceipt(state);
    state.isOrdering = false;
    state.menu = [];
    state.orders = [];

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: receiptText
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
