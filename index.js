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

// 呼叫 Gemini AI 辨識圖片（加上除錯與防呆）
async function recognizeMenuWithGemini(base64Image) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const prompt = `你是一個精準的菜單辨識助手。請辨識這張圖片中的所有餐點品項與價格。
如果這請判定這絕對不是菜單，請只回傳：{"isMenu": false}。
如果是菜單或價目表，請嚴格以純 JSON 格式回傳（不要包含 \`\`\`json 標記），格式如下：
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
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('AI 未回傳任何內容，可能圖片過大或格式不支援。');
  }

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

  // 1. 處理圖片訊息（會回報辨識狀況）
  if (event.message.type === 'image') {
    try
