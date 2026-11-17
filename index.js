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

// 🚀 極速優化：將圖片縮小至 800px 並壓縮，大幅降低 AI 讀圖負擔與延遲
async function compressImageFast(buffer) {
  try {
    const image = await Jimp.read(buffer);
    if (image.bitmap.width > 800) {
      image.resize(800, Jimp.AUTO);
    }
    return await image.quality(75).getBufferAsync(Jimp.MIME_JPEG);
  } catch (err) {
    console.warn('⚠️ 圖片壓縮失敗，使用原圖:', err.message);
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

// 🚀 多模型自動輪替與智慧重試機制（徹底解決過載與逾時）
async function callGeminiUltraFast(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY！');

  const models = ['gemini-3.8-flash', 'gemini-flash-latest'];
  const prompt = `提取菜單品項與價格。大小份拆開如「品項(大)」。價格為純數字，無價格填0。嚴格只回傳純JSON：{"isMenu":true,"items":[{"name":"品項","price":數字}]}`;

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) { // 每個模型嘗試 2 次
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000); // 縮短至 12 秒快速切換

      try {
        console.log(`⚡ [模型: ${model}] 嘗試解析 (第 ${attempt} 次)...`);
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
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        if (data.error) throw new Error(`${model} 錯誤: ${data.error.message}`);
        if (!data.candidates || data.candidates.length === 0) throw new Error(`${model} 未回傳內容`);

        const text = data.candidates[0].content.parts[0].text;
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        console.log(`✅ [模型: ${model}] 解析成功！`);
        return JSON.parse(cleanText);
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`⚠️ [模型: ${model}] 失敗 (${err.message})`);
        lastError = err;
        await new Promise(resolve => setTimeout(resolve, 800)); // 短暫間隔後重試
      }
    }
  }

  throw lastError || new Error('所有 AI 模型皆過載');
}

function generateReportText(state, titlePrefix) {
  const summary = {};
  let totalAmount = 0;

  state.orders.forEach(o => {
    const key = `${o.item}${o.price > 0 ? ` ($${o.price})` : ''}`;
    summary[key] = (summary[key] || 0) + o.quantity;
    totalAmount += o.price * o.quantity;
  });

  const summaryLines = Object.entries(summary)
    .map(([item, count]) => `▫️ ${item} ➔ ${count} 份`)
    .join('\n');

  const userOrdersMap = {};
  state.orders.forEach(o => {
    if (!userOrdersMap[o.userName]) {
      userOrdersMap[o.userName] = { items: [], subtotal: 0 };
    }
    userOrdersMap[o.userName].items.push(o);
    userOrdersMap[o.userName].subtotal += (o.price * o.quantity);
  });

  const detailLines = Object.entries(userOrdersMap)
    .map(([userName, data]) => {
      const itemListStr = data.items
        .map(i => {
          const noteStr = i.note ? ` [${i.note}]` : '';
          const qtyStr = i.quantity > 1 ? ` x${i.quantity}` : '';
          return `   - ${i.item}${qtyStr} ($${i.price * i.quantity})${noteStr}`;
        })
        .join('\n');
      return `• ${userName}：\n${itemListStr}\n   👉 **個人小計：$${data.subtotal}**`;
    })
    .join('\n\n');

  const timerBanner = state.closeTimeText ? `\n⏰ 預計自動結單：${state.closeTimeText}` : '';
  const creatorBanner = state.creatorName ? `\n👑 發起人：${state.creatorName}` : '';

  return `${titlePrefix}${creatorBanner}${timerBanner}\n\n📦 【店家叫餐清單】\n${summaryLines}\n\n──────────────────\n💰 **總金額：$${totalAmount}**\n\n👤 【群友付款明細】\n${detailLines}`;
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
    state.creatorId = null;
    state.creatorName = null;
    client.pushMessage(groupId, {
      type: 'text',
      text: '⏰ 結單時間已到！本次無人點餐，系統已自動結束訂單。'
    }).catch(console.error);
    return;
  }

  const reportText = generateReportText(state, '🏁 ─── 【自動結單明細】 ───');
  state.isOrdering = false;
  state.menu = [];
  state.orders = [];
  state.creatorId = null;
  state.creatorName = null;

  client.pushMessage(groupId, {
    type: 'text',
    text: `⏰ 結單時間已到！系統已自動為您結單：\n\n${reportText}\n\n感謝大家使用！`
  }).catch(console.error);
}

function parseOrderSegment(segment, menu) {
  let quantity = 1;
  let isMinus = false;
  let cleanSegment = segment;

  const qtyMatch = cleanSegment.match(/^([+-＋\–])(\d+)\s*(.*)$/);
  if (qtyMatch) {
    isMinus = (qtyMatch[1] === '-' || qtyMatch[1] === '－' || qtyMatch[1] === '–');
    quantity = parseInt(qtyMatch[2], 10);
    cleanSegment = qtyMatch[3].trim();
  } else {
    const middleQtyMatch = cleanSegment.match(/(.+?)\s+([+-＋\–])(\d+)(?:\s|$)(.*)/);
    if (middleQtyMatch) {
      cleanSegment = middleQtyMatch[1].trim();
      isMinus = (middleQtyMatch[2] === '-' || middleQtyMatch[2] === '－' || middleQtyMatch[2] === '–');
      quantity = parseInt(middleQtyMatch[3], 10);
      const trailing = middleQtyMatch[4].trim();
      if (trailing) cleanSegment += ' ' + trailing;
    }
  }

  let matchedPrice = 0;
  let detectedItem = cleanSegment;
  let customNote = '';

  if (menu && menu.length > 0) {
    const sortedMenu = [...menu].sort((a, b) => b.name.length - a.name.length);
    let found = sortedMenu.find(m => cleanSegment.includes(m.name));

    if (!found) {
      const cleanStr = cleanSegment.replace(/[()（）\-\s]/g, '');
      found = sortedMenu.find(m => {
        const cleanMenuName = m.name.replace(/[()（）\-\s]/g, '');
        return cleanStr.includes(cleanMenuName);
      });
    }

    if (found) {
      matchedPrice = found.price;
      detectedItem = found.name;
      customNote = cleanSegment.replace(found.name, '').replace(/[()（）]/g, '').trim();
      return { item: detectedItem, price: matchedPrice, quantity, note: customNote, isMinus };
    }
  }

  const explicitPriceMatch = cleanSegment.match(/(?:^|\s|\$)(\d+)(?:\s|$|元)/);
  if (explicitPriceMatch) {
    matchedPrice = parseInt(explicitPriceMatch[1], 10);
    const withoutPrice = cleanSegment.replace(explicitPriceMatch[0], ' ').replace(/\s+/g, ' ').trim();
    const parts = withoutPrice.split(/\s+/);
    detectedItem = parts[0] || withoutPrice;
    customNote = parts.slice(1).join(' ');
    return { item: detectedItem, price: matchedPrice, quantity, note: customNote, isMinus };
  }

  const fallbackParts = cleanSegment.split(/\s+/);
  detectedItem = fallbackParts[0] || cleanSegment;
  customNote = fallbackParts.slice(1).join(' ');
  return { item: detectedItem, price: 0, quantity, note: customNote, isMinus };
}

function parseCloseTimeCommand(text) {
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

  const timeMatch = text.match(/^(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*[:：點時]\s*(\d{1,2}|半)?\s*分?\s*結單$/);
  if (timeMatch) {
    const period = timeMatch[1] || '';
    let hour = parseInt(timeMatch[2], 10);
    let minute = 0;

    if (timeMatch[3] === '半') minute = 30;
    else if (timeMatch[3]) minute = parseInt(timeMatch[3], 10);

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
      else if (period === '中午' && hour < 11) hour += 12;

      const nowUtc = Date.now();
      const taipeiOffset = 8 * 3600 * 1000;
      const nowTaipei = new Date(nowUtc + taipeiOffset);

      const targetTaipei = new Date(nowTaipei.getTime());
      targetTaipei.setUTCHours(hour, minute, 0, 0);

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
      creatorId: null,
      creatorName: null,
      closeTimer: null,
      closeTimeText: null
    };
  }
  const state = groupStates[groupId];
  const userId = event.source.userId;
  const userName = await getUserName(event);

  // 🖼️ 處理圖片訊息（發起開單）
  if (event.message.type === 'image') {
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
      state.closeTimeText = null;
    }

    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 收到菜單！AI 正在進行極速壓縮與多模型解析，請稍候...'
      });

      const rawBuffer = await getImageBuffer(event.message.id);
      const compressedBuffer = await compressImageFast(rawBuffer);
      const base64Image = compressedBuffer.toString('base64');
      const parsed = await callGeminiUltraFast(base64Image);

      if (!parsed.isMenu || !parsed.items || parsed.items.length === 0) {
        return client.pushMessage(groupId, { type: 'text', text: '⚠️ AI 找不到清晰的品項與價格！' });
      }

      state.isOrdering = true;
      state.menu = parsed.items;
      state.orders = [];
      state.creatorId = userId;
      state.creatorName = userName;

      const menuListText = parsed.items.map(i => `• ${i.name}：$${i.price}`).join('\n');
      return client.pushMessage(groupId, {
        type: 'text',
        text: `👑 發起人：${userName}\n📋 菜單辨識成功！\n\n${menuListText}\n\n👉 點餐範例：「+1 品項」或「+2 品項」、「-1 品項」、「全部取消」\n⏰ 僅限發起人可設定結單與統計！`
      });
    } catch (err) {
      state.isOrdering = true;
      state.menu = [];
      state.orders = [];
      state.creatorId = userId;
      state.creatorName = userName;

      return client.pushMessage(groupId, {
        type: 'text',
        text: `👑 發起人：${userName}\n⚠️ 目前 AI 伺服器尖峰過載，已自動切換為「手動點餐」模式！\n請直接輸入：「+1 品項 價格」`
      });
    }
  }

  if (event.message.type !== 'text') return;
  const rawText = event.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (lowerText === '點餐神助手') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🤖 **點餐神助手已上線！**\n\n📌 **使用方式：**\n1. 傳送「菜單照片」或輸入「開單」來發起點餐。\n2. 點餐/加減數量：\n   • `+1 滷肉飯` 或 `+2 珍奶`\n   • `-1 滷肉飯`（扣除或刪除該品項）\n   • `全部取消`（清除你先前點過的所有品項）\n3. **僅限發起人**可輸入「統計」、「結單」或設定自動結單時間（例如：「11:30結單」）。'
    });
  }

  if (!state.isOrdering && rawText !== '開單') {
    return;
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
    state.creatorId = userId;
    state.creatorName = userName;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📢 **已由 ${userName} 開啟自由點餐！**\n請輸入：「+1 品項 價格 備註」\n⏰ 僅限發起人可進行結單與統計！`
    });
  }

  const timeCmd = parseCloseTimeCommand(rawText);
  if (timeCmd) {
    if (state.creatorId && state.creatorId !== userId) {
      return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 只有本次開單發起人（${state.creatorName}）才能設定自動結單喔！` });
    }

    if (state.closeTimer) clearTimeout(state.closeTimer);

    state.closeTimeText = timeCmd.displayStr;
    state.closeTimer = setTimeout(() => {
      executeAutoClose(groupId);
    }, timeCmd.delayMs);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `⏰ 已設定自動結單時間：將於 ${timeCmd.displayStr} 準時自動結單！`
    });
  }

  if (rawText === '全部取消') {
    const beforeCount = state.orders.length;
    state.orders = state.orders.filter(o => o.userId !== userId);
    const removedCount = beforeCount - state.orders.length;

    if (removedCount === 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 你目前沒有任何點餐紀錄可以清除喔！' });
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🗑️ 已為 ${userName} 清除所有先前的點餐紀錄，您可以重新點餐囉！`
    });
  }

  if (/^[+\-＋\–\–]?\d*\s*[\+＋\-\－\–]/.test(rawText) || rawText.startsWith('+') || rawText.startsWith('＋') || rawText.startsWith('-') || rawText.startsWith('－') || rawText.startsWith('–') || rawText.includes('+') || rawText.includes('＋')) {
    const subSegments = rawText
      .split(/(?=[+\-＋\–\–]\d+)/g)
      .map(s => s.trim())
      .filter(Boolean);

    if (subSegments.length === 0) return;

    const actionResults = [];

    for (const segment of subSegments) {
      const parsed = parseOrderSegment(segment, state.menu);

      if (parsed.isMinus) {
        const existingIdx = state.orders.findIndex(
          o => o.userId === userId && o.item.toLowerCase() === parsed.item.toLowerCase()
        );
        if (existingIdx !== -1) {
          const currentItem = state.orders[existingIdx];
          if (currentItem.quantity > parsed.quantity) {
            currentItem.quantity -= parsed.quantity;
            actionResults.push(`➖ 已將 ${currentItem.item} 數量扣除 ${parsed.quantity}（剩餘 ${currentItem.quantity} 份）`);
          } else {
            state.orders.splice(existingIdx, 1);
            actionResults.push(`🗑️ 已完全移除 ${currentItem.item}`);
          }
        } else {
          actionResults.push(`⚠️ 找不到你的「${parsed.item}」紀錄可扣除`);
        }
      } else {
        const existingItem = state.orders.find(
          o => o.userId === userId && o.item.toLowerCase() === parsed.item.toLowerCase() && o.note === parsed.note
        );

        if (existingItem) {
          existingItem.quantity += parsed.quantity;
        } else {
          state.orders.push({
            userId,
            userName,
            item: parsed.item,
            price: parsed.price,
            quantity: parsed.quantity,
            note: parsed.note
          });
        }

        const priceText = parsed.price > 0 ? `💰 $${parsed.price}` : '💰 $0';
        const qtyText = parsed.quantity > 1 ? ` x${parsed.quantity}` : '';
        const noteText = parsed.note ? ` 📝 [${parsed.note}]` : '';
        actionResults.push(`• ${parsed.item}${qtyText} (${priceText})${noteText}`);
      }
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已更新 ${userName} 的點餐：\n${actionResults.join('\n')}`
    });
  }

  if (rawText === '統計' || rawText === '目前訂單') {
    if (state.creatorId && state.creatorId !== userId) {
      return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 只有本次開單發起人（${state.creatorName}）才能查看統計喔！` });
    }
    if (state.orders.length === 0) {
      const timerHint = state.closeTimeText ? `\n⏰ 預計結單時間：${state.closeTimeText}` : '';
      return client.replyMessage(event.replyToken, { type: 'text', text: `📭 目前還沒有人點餐喔！${timerHint}` });
    }

    const reportText = generateReportText(state, '📊 ─── 【目前點餐統計】 ───');
    return client.replyMessage(event.replyToken, { type: 'text', text: reportText });
  }

  if (rawText === '結單') {
    if (state.creatorId && state.creatorId !== userId) {
      return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 只有本次開單發起人（${state.creatorName}）才能執行結單喔！` });
    }

    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
      state.closeTimeText = null;
    }

    if (state.orders.length === 0) {
      state.isOrdering = false;
      state.menu = [];
      state.creatorId = null;
      state.creatorName = null;
      return client.replyMessage(event.replyToken, { type: 'text', text: '🏁 訂單已結束（無人點餐）。' });
    }

    const receiptText = generateReportText(state, '🏁 ─── 【最終結單明細】 ───');
    state.isOrdering = false;
    state.menu = [];
    state.orders = [];
    state.creatorId = null;
    state.creatorName = null;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${receiptText}\n\n感謝大家使用！下次點餐請再傳菜單或輸入「開單」～`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
