// ============================================================
// UNDERDOG EDGE AI — Unified Cloudflare Worker
// Proxy + Lineup Validation + CLV Tracking + AI (DeepSeek/Gemini)
// ============================================================

const MLB_STATS_BASE = 'https://statsapi.mlb.com/api/v1';

export default {
  async fetch(request, env) {
    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    const url = new URL(request.url);

    // ---- Lineup check routes ----
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

    // ---- AI ENDPOINT: DeepSeek primary, Gemini fallback ----
    if (url.pathname === '/ai') {
      try {
        const body = await request.json();
        const { systemPrompt, userPrompt, temperature, maxTokens, geminiKey } = body;

        // Try DeepSeek first
        try {
          const dsResponse = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer sk-9edc49f6ba0942ceb34471ae3f142e0f',
            },
            body: JSON.stringify({
              model: 'deepseek-v4-flash',
              messages: [
                { role: 'system', content: systemPrompt || '' },
                { role: 'user', content: userPrompt || '' },
              ],
              temperature: temperature || 0.3,
              max_tokens: maxTokens || 8000,
            }),
          });

          if (dsResponse.ok) {
            const dsData = await dsResponse.json();
            const text = dsData.choices?.[0]?.message?.content || '';
            return jsonResponse({ text, provider: 'deepseek', model: 'deepseek-v4-flash' });
          }

          console.log('DeepSeek failed, status:', dsResponse.status, '— falling back to Gemini');
        } catch (dsErr) {
          console.log('DeepSeek error:', dsErr.message, '— falling back to Gemini');
        }

        // Fallback: Gemini
        try {
          const gKey = geminiKey || '';
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gKey}`;

          const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt || '' }] },
              contents: [{ parts: [{ text: userPrompt || '' }] }],
              generationConfig: {
                temperature: temperature || 0.3,
                maxOutputTokens: maxTokens || 16000,
              },
            }),
          });

          if (geminiResponse.ok) {
            const geminiData = await geminiResponse.json();
            const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return jsonResponse({ text, provider: 'gemini', model: 'gemini-2.5-flash' });
          }

          console.log('Gemini also failed, status:', geminiResponse.status);
          return jsonResponse({ error: 'Both DeepSeek and Gemini failed', text: '' }, 502);
        } catch (gemErr) {
          return jsonResponse({ error: 'Both AI providers failed', details: gemErr.message }, 502);
        }
      } catch (e) {
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }
    }

    // ---- EXISTING: Proxy logic ----
    const target = url.searchParams.get('url');
    const league = url.searchParams.get('league');

    if (!target) return new Response('Missing url param', { status: 400 });

    const isSharp = target.includes('sharpapi.io');
    const isApify = target.includes('apify.com');
    const isParlay = target.includes('parlay-api.com');

    const fetchHeaders = {};
    if (isSharp) fetchHeaders['X-API-Key'] = 'sk_live_JUwiPqiq87FsTfXgXfpG63';
    if (isParlay) fetchHeaders['X-API-Key'] = '1d8c523f514adba9f47d239b912359c0';
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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      }
    });
  },

  // ---- CRON HANDLER ----
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};


// ============================================================
// CRON HANDLER
// ============================================================

async function handleScheduled(event, env) {
  console.log(`Cron fired at ${new Date().toISOString()}`);

  const lineupResult = await checkLineups(env);
  console.log(`Lineup check: ${lineupResult.confirmed} confirmed, ${lineupResult.notConfirmed} pending`);
}


// ============================================================
// LINEUP VALIDATION
// ============================================================

async function checkLineups(env) {
  const today = getTodayDateString();

  const scheduleRes = await fetch(
    `${MLB_STATS_BASE}/schedule?sportId=1&date=${today}&hydrate=probablePitcher,lineups`
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
      const boxRes = await fetch(`${MLB_STATS_BASE}/game/${gameId}/boxscore`);
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
      `lineups:${today}`,
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
    const player = players[`ID${playerId}`] || {};
    return {
      id: playerId,
      fullName: player.person?.fullName || `Player ${playerId}`,
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
  const data = await env.LINEUP_KV.get(`lineups:${today}`, 'json');

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
// PROP SNAPSHOTS (for CLV tracking)
// ============================================================

async function savePropsSnapshot(props, env) {
  if (!env.LINEUP_KV || !props.length) {
    return { saved: 0, reason: !env.LINEUP_KV ? 'KV not configured' : 'No props provided' };
  }

  const timestamp = new Date().toISOString();
  const today = getTodayDateString();

  let saved = 0;
  for (const prop of props) {
    const key = `prop:${today}:${prop.playerId || prop.playerName}:${prop.propType}:${timestamp}`;
    await env.LINEUP_KV.put(key, JSON.stringify({
      ...prop,
      timestamp,
      gameDate: today,
    }), { expirationTtl: 172800 });
    saved++;
  }

  for (const prop of props) {
    const latestKey = `latest:${today}:${prop.playerId || prop.playerName}:${prop.propType}`;
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

  const list = await env.LINEUP_KV.list({ prefix: `latest:${gameDate}:` });
  const closingLines = [];

  for (const key of list.keys) {
    const data = await env.LINEUP_KV.get(key.name, 'json');
    if (data) {
      closingLines.push(data);
    }
  }

  return { gameDate, count: closingLines.length, lines: closingLines };
}


// ============================================================
// UTILITIES
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    },
  });
}

function getTodayDateString() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const year = eastern.getFullYear();
  const month = String(eastern.getMonth() + 1).padStart(2, '0');
  const day = String(eastern.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
