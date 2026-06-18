// ============================================================
// UNDERDOG EDGE AI — Unified Cloudflare Worker
// Proxy + Lineup Validation + CLV Tracking + AI (DeepSeek/Gemini)
// MERGED: includes x-goog-api-key header, timeouts, 8000 token
//         floor, debug logging, response_format for DeepSeek
// ============================================================

const MLB_STATS_BASE = 'https://statsapi.mlb.com/api/v1';

// !! REPLACE THESE WITH YOUR REAL KEYS BEFORE DEPLOYING !!
const GEMINI_API_KEY = 'AQ.Ab8RN6Jhxy0qf-i4vDd9Dk9Nx1X3FXtp2JyO8CQo3dqcjGQTkA';
const DEEPSEEK_API_KEY = 'sk-9edc49f6ba0942ceb34471ae3f142e0f';
const SHARP_API_KEY = 'sk_live_JUwiPqiq87FsTfXgXfpG63';
const PARLAY_API_KEY = '1d8c523f514adba9f47d239b912359c0';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MIN_DEEPSEEK_MAX_TOKENS = 8000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ---- Lineup routes ----
    if (url.pathname === '/lineup-check') {
      const result = await checkLineups(env);
      return jsonResponse(result);
    }

    if (url.pathname === '/lineup-status') {
      const playerName = url.searchParams.get('player');
      if (!playerName) return jsonResponse({ status: 'ERROR', reason: 'Missing player param' }, 400);
      const result = await getPlayerLineupStatus(playerName, env);
      return jsonResponse(result);
    }

    if (url.pathname === '/lineup-bulk') {
      try {
        const body = await request.json();
        const players = body.players || [];
        const results = {};
        for (const name of players) {
          results[name] = await getPlayerLineupStatus(name, env);
        }
        return jsonResponse(results);
      } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
    }

    // ---- CLV / Props snapshot routes ----
    if (url.pathname === '/snapshot-props') {
      try {
        const body = await request.json();
        const result = await savePropsSnapshot(body.props || [], env);
        return jsonResponse(result);
      } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (url.pathname === '/closing-lines') {
      const gameDate = url.searchParams.get('date') || getTodayDateString();
      const result = await getClosingLines(gameDate, env);
      return jsonResponse(result);
    }

    // ---- AI ENDPOINT ----
    if (url.pathname === '/ai') {
      return handleAI(request);
    }

    // ---- PROXY (Apify, SharpAPI, ParlayAPI) ----
    return handleProxy(url);
  },

  // ---- CRON HANDLER ----
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};


// ============================================================
// AI HANDLER — Gemini primary (120s) + DeepSeek fallback
// With Workers Paid + cpu_ms=300000, we have 5 minutes total
// ============================================================

async function handleAI(request) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const workerStartTime = Date.now();
  const WORKER_BUDGET_MS = 270000; // 4.5 min — leaves 30s safety margin under 5-min limit

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const systemPrompt = body.systemPrompt || '';
  const userPrompt = body.userPrompt || body.prompt || '';
  const temperature = body.temperature || 0.3;
  const requestedMaxTokens = body.maxTokens || 8000;

  if (!userPrompt) {
    return jsonResponse({ error: 'Missing prompt / userPrompt' }, 400);
  }

  const deepseekMaxTokens = Math.max(requestedMaxTokens, MIN_DEEPSEEK_MAX_TOKENS);
  console.log('[WORKER] budget: 5min mode | requestedMaxTokens:', requestedMaxTokens, 'deepseekMaxTokens:', deepseekMaxTokens);

  let geminiError = null;

  // ===== PRIMARY: Gemini 2.5 Flash (120s timeout) =====
  try {
    const geminiController = new AbortController();
    const geminiTimeout = setTimeout(() => geminiController.abort(), 120000); // 2 full minutes

    const combinedPrompt = systemPrompt
      ? systemPrompt + '\n\n' + userPrompt
      : userPrompt;

    const geminiBody = {
      contents: [{ parts: [{ text: combinedPrompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    if (systemPrompt) {
      geminiBody.system_instruction = { parts: [{ text: systemPrompt }] };
      geminiBody.contents = [{ parts: [{ text: userPrompt }] }];
    }

    console.log('[GEMINI] starting (primary, 120s timeout), t=' + (Date.now() - workerStartTime) + 'ms');

    const geminiResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(geminiBody),
      signal: geminiController.signal,
    });

    clearTimeout(geminiTimeout);
    console.log('[GEMINI] status:', geminiResponse.status, 't=' + (Date.now() - workerStartTime) + 'ms');

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.log('[GEMINI] error body:', errText.substring(0, 500));
      geminiError = 'HTTP ' + geminiResponse.status + ': ' + errText.substring(0, 200);
      throw new Error(geminiError);
    }

    const geminiData = await geminiResponse.json();
    const geminiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!geminiText) {
      console.log('[GEMINI] empty candidates:', JSON.stringify(geminiData?.candidates || []).substring(0, 300));
      geminiError = 'Empty Gemini response (possible safety filter)';
      throw new Error(geminiError);
    }

    console.log('[GEMINI] SUCCESS length:', geminiText.length, 't=' + (Date.now() - workerStartTime) + 'ms');
    return jsonResponse({
      text: geminiText,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      elapsed: Date.now() - workerStartTime,
    });

  } catch (err) {
    geminiError = geminiError || (err.name + ': ' + err.message);
    console.log('[GEMINI FAILED]', geminiError, 't=' + (Date.now() - workerStartTime) + 'ms');
  }

  // ===== FALLBACK: DeepSeek =====
  const remainingTime = WORKER_BUDGET_MS - (Date.now() - workerStartTime);
  console.log('[DEEPSEEK] entering fallback, remaining:', remainingTime + 'ms');

  if (remainingTime < 5000) {
    return jsonResponse({
      error: 'Both providers failed. Gemini: ' + geminiError + '. Insufficient time for DeepSeek.',
      geminiError,
    }, 504);
  }

  try {
    const dsController = new AbortController();
    const dsTimeout = setTimeout(() => dsController.abort(), Math.min(remainingTime - 1000, 120000));

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    } else {
      messages.push({ role: 'system', content: 'You are a sports betting analyst. Always respond with valid JSON only, no markdown.' });
    }
    messages.push({ role: 'user', content: userPrompt });

    const dsBody = {
      model: 'deepseek-chat',
      messages,
      temperature,
      max_tokens: deepseekMaxTokens,
      response_format: { type: 'json_object' },
    };

    console.log('[DEEPSEEK] starting fallback, max_tokens:', deepseekMaxTokens, 't=' + (Date.now() - workerStartTime) + 'ms');

    const dsResponse = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify(dsBody),
      signal: dsController.signal,
    });

    clearTimeout(dsTimeout);
    console.log('[DEEPSEEK] status:', dsResponse.status, 't=' + (Date.now() - workerStartTime) + 'ms');

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      console.log('[DEEPSEEK] error body:', errText.substring(0, 500));
      return jsonResponse({
        error: 'DeepSeek HTTP ' + dsResponse.status + ': ' + errText.substring(0, 200),
        geminiError,
      }, 502);
    }

    const dsData = await dsResponse.json();
    const dsText = dsData?.choices?.[0]?.message?.content;
    const finishReason = dsData?.choices?.[0]?.finish_reason;

    if (!dsText) {
      return jsonResponse({ error: 'Empty DeepSeek response', geminiError }, 502);
    }

    console.log('[DEEPSEEK] SUCCESS length:', dsText.length, 'finish_reason:', finishReason, 't=' + (Date.now() - workerStartTime) + 'ms');
    if (finishReason === 'length') {
      console.log('[DEEPSEEK WARNING] hit max_tokens limit — response may be truncated');
    }

    return jsonResponse({
      text: dsText,
      provider: 'deepseek',
      model: 'deepseek-chat',
      finishReason,
      geminiError,
      elapsed: Date.now() - workerStartTime,
    });

  } catch (err) {
    console.log('[DEEPSEEK FAILED]', err.name, err.message, 't=' + (Date.now() - workerStartTime) + 'ms');
    return jsonResponse({
      error: 'Both providers failed. Gemini: ' + geminiError + '. DeepSeek: ' + err.message,
      geminiError,
      deepseekError: err.message,
    }, 502);
  }
}


// ============================================================
// PROXY HANDLER (Apify, SharpAPI, ParlayAPI)
// ============================================================

async function handleProxy(url) {
  const target = url.searchParams.get('url');
  const league = url.searchParams.get('league');

  if (!target) return new Response('Missing url param', { status: 400, headers: CORS_HEADERS });

  const isSharp = target.includes('sharpapi.io');
  const isApify = target.includes('apify.com');
  const isParlay = target.includes('parlay-api.com');

  const fetchHeaders = {};
  if (isSharp) fetchHeaders['X-API-Key'] = SHARP_API_KEY;
  if (isParlay) fetchHeaders['X-API-Key'] = PARLAY_API_KEY;
  if (isApify) fetchHeaders['Content-Type'] = 'application/json';

  let fetchMethod = 'GET';
  let fetchBody = undefined;

  if (isApify && league) {
    fetchMethod = 'POST';
    fetchBody = JSON.stringify({ leagues: [league] });
  }

  const resp = await fetch(target, {
    method: fetchMethod,
    headers: fetchHeaders,
    body: fetchBody,
  });

  const respBody = await resp.text();

  return new Response(respBody, {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}


// ============================================================
// CRON HANDLER
// ============================================================

async function handleScheduled(event, env) {
  console.log('Cron fired at ' + new Date().toISOString());
  const lineupResult = await checkLineups(env);
  console.log('Lineup check: ' + lineupResult.confirmed + ' confirmed, ' + lineupResult.notConfirmed + ' pending');
}


// ============================================================
// LINEUP VALIDATION
// ============================================================

async function checkLineups(env) {
  const today = getTodayDateString();

  const scheduleRes = await fetch(
    MLB_STATS_BASE + '/schedule?sportId=1&date=' + today + '&hydrate=probablePitcher,lineups'
  );
  const schedule = await scheduleRes.json();

  if (!schedule.dates || schedule.dates.length === 0) {
    return { date: today, games: 0, confirmed: 0, notConfirmed: 0, players: [] };
  }

  const games = schedule.dates[0].games || [];
  const playerStatuses = [];

  for (const game of games) {
    const gameId = game.gamePk;
    const gameTime = game.gameDate;
    const awayTeam = game.teams?.away?.team?.name || 'Unknown';
    const homeTeam = game.teams?.home?.team?.name || 'Unknown';

    let awayLineup = [];
    let homeLineup = [];

    try {
      const boxRes = await fetch(MLB_STATS_BASE + '/game/' + gameId + '/boxscore');
      const box = await boxRes.json();
      awayLineup = extractLineup(box?.teams?.away);
      homeLineup = extractLineup(box?.teams?.home);
    } catch (e) {
      // Boxscore not available yet
    }

    const awayPitcher = game.teams?.away?.probablePitcher;
    const homePitcher = game.teams?.home?.probablePitcher;

    if (awayPitcher) {
      playerStatuses.push({
        playerId: awayPitcher.id,
        playerName: awayPitcher.fullName,
        team: awayTeam,
        opponent: homeTeam,
        gameId, gameTime,
        role: 'pitcher',
        lineupStatus: 'CONFIRMED',
        battingOrder: null,
        lastChecked: new Date().toISOString(),
      });
    }

    if (homePitcher) {
      playerStatuses.push({
        playerId: homePitcher.id,
        playerName: homePitcher.fullName,
        team: homeTeam,
        opponent: awayTeam,
        gameId, gameTime,
        role: 'pitcher',
        lineupStatus: 'CONFIRMED',
        battingOrder: null,
        lastChecked: new Date().toISOString(),
      });
    }

    for (const batter of [...awayLineup, ...homeLineup]) {
      playerStatuses.push({
        playerId: batter.id,
        playerName: batter.fullName,
        team: batter.team,
        opponent: batter.team === awayTeam ? homeTeam : awayTeam,
        gameId, gameTime,
        role: 'batter',
        lineupStatus: 'CONFIRMED',
        battingOrder: batter.battingOrder,
        lastChecked: new Date().toISOString(),
      });
    }
  }

  if (env.LINEUP_KV) {
    await env.LINEUP_KV.put(
      'lineups:' + today,
      JSON.stringify(playerStatuses),
      { expirationTtl: 86400 }
    );
  }

  const confirmed = playerStatuses.filter(p => p.lineupStatus === 'CONFIRMED').length;

  return {
    date: today,
    games: games.length,
    confirmed,
    notConfirmed: 0,
    players: playerStatuses,
    lastChecked: new Date().toISOString(),
  };
}

function extractLineup(teamBox) {
  if (!teamBox?.battingOrder || teamBox.battingOrder.length === 0) return [];
  const players = teamBox.players || {};
  return teamBox.battingOrder.map((playerId, idx) => {
    const player = players['ID' + playerId] || {};
    return {
      id: playerId,
      fullName: player.person?.fullName || ('Player ' + playerId),
      team: teamBox.team?.name || 'Unknown',
      battingOrder: idx + 1,
    };
  });
}


// ============================================================
// SINGLE PLAYER LINEUP STATUS
// ============================================================

async function getPlayerLineupStatus(playerName, env) {
  if (!env.LINEUP_KV) {
    return { status: 'NOT_CONFIRMED', reason: 'KV not configured' };
  }

  const today = getTodayDateString();
  const data = await env.LINEUP_KV.get('lineups:' + today, 'json');

  if (!data) {
    return { status: 'NOT_CONFIRMED', reason: 'No lineup data yet — cron may not have run' };
  }

  const nameLower = playerName.toLowerCase().trim();

  let match = data.find(p => p.playerName.toLowerCase() === nameLower);
  if (!match) {
    match = data.find(p => {
      const parts = nameLower.split(' ').filter(w => w.length > 2);
      return parts.every(part => p.playerName.toLowerCase().includes(part));
    });
  }

  if (match) {
    return {
      status: match.lineupStatus,
      battingOrder: match.battingOrder,
      team: match.team,
      opponent: match.opponent,
      role: match.role,
      gameTime: match.gameTime,
      lastChecked: match.lastChecked,
    };
  }

  return { status: 'NOT_CONFIRMED', reason: 'Player not found in confirmed lineups' };
}


// ============================================================
// PROP SNAPSHOTS (CLV tracking)
// ============================================================

async function savePropsSnapshot(props, env) {
  if (!env.LINEUP_KV || !props.length) {
    return { saved: 0, reason: !env.LINEUP_KV ? 'KV not configured' : 'No props provided' };
  }

  const timestamp = new Date().toISOString();
  const today = getTodayDateString();

  let saved = 0;
  for (const prop of props) {
    const key = 'prop:' + today + ':' + (prop.playerId || prop.playerName) + ':' + prop.propType + ':' + timestamp;
    await env.LINEUP_KV.put(key, JSON.stringify({
      ...prop,
      timestamp,
      gameDate: today,
    }), { expirationTtl: 172800 });
    saved++;
  }

  for (const prop of props) {
    const latestKey = 'latest:' + today + ':' + (prop.playerId || prop.playerName) + ':' + prop.propType;
    await env.LINEUP_KV.put(latestKey, JSON.stringify({
      ...prop,
      timestamp,
      gameDate: today,
    }), { expirationTtl: 172800 });
  }

  return { saved, timestamp };
}

async function getClosingLines(gameDate, env) {
  if (!env.LINEUP_KV) {
    return { error: 'KV not configured' };
  }

  const list = await env.LINEUP_KV.list({ prefix: 'latest:' + gameDate + ':' });
  const closingLines = [];

  for (const key of list.keys) {
    const data = await env.LINEUP_KV.get(key.name, 'json');
    if (data) closingLines.push(data);
  }

  return { gameDate, count: closingLines.length, lines: closingLines };
}


// ============================================================
// UTILITIES
// ============================================================

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function getTodayDateString() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const year = eastern.getFullYear();
  const month = String(eastern.getMonth() + 1).padStart(2, '0');
  const day = String(eastern.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
