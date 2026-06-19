// ============================================================
// UNDERDOG EDGE AI — Unified Cloudflare Worker
// Proxy + Lineup Validation + CLV Tracking + AI (DeepSeek/Gemini)
// MERGED: includes x-goog-api-key header, timeouts, 8000 token
//         floor, debug logging, response_format for DeepSeek
// + Multi-sport Sportradar (MLB/WNBA/Soccer/Global Basketball/
//   Global Baseball) + Sportradar Odds Player Props
// ============================================================

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";
var GEMINI_API_KEY = "AQ.Ab8RN6IA3PgAannoLdEph--PINEtQI46Nz1ZBq7QMKk4r9xM7A";
var DEEPSEEK_API_KEY = "sk-9edc49f6ba0942ceb34471ae3f142e0f";
var SHARP_API_KEY = "sk_live_JUwiPqiq87FsTfXgXfpG63";
var PARLAY_API_KEY = "1d8c523f514adba9f47d239b912359c0";
var THE_ODDS_API_KEY = "f7799b2d6c48116a21658bc06dc4746c";
var SPORTSDATAIO_MLB_API_KEY = "d4fd4cb3680244f4b108aab6de86ca95";
var OPENWEATHER_API_KEY = "6fa7ee8cb82058ced5c0cbe96d9ab8bc";
var SPORTRADAR_API_KEY = "ZhCxRp1EtW5BnG3AsSJl65j4okjKf418lCwkBkPK";
var SPORTRADAR_ACCESS_LEVEL = "trial";
var SPORTRADAR_LANGUAGE_CODE = "en";
var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
var DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
var THE_ODDS_BASE = "https://api.the-odds-api.com/v4";
var SPORTSDATAIO_BASE = "https://api.sportsdata.io/v3/mlb";
var OPENWEATHER_BASE = "https://api.openweathermap.org/data/2.5";
var SPORTRADAR_BASE = "https://api.sportradar.us/mlb";
var MIN_DEEPSEEK_MAX_TOKENS = 8e3;

// ---- Multi-sport Sportradar config ----
// Same SPORTRADAR_API_KEY is reused across all sports below.
// Each sport has its own base path / version / language since
// Sportradar's endpoint shapes differ per sport.
var SPORTRADAR_SPORT_CONFIG = {
  mlb: {
    label: "MLB",
    base: "https://api.sportradar.com/mlb",
    version: "v8",
    language: "en"
  },
  wnba: {
    label: "WNBA",
    base: "https://api.sportradar.com/wnba",
    version: "v8",
    language: "en"
  },
  soccer: {
    label: "Soccer",
    base: "https://api.sportradar.com/soccer",
    version: "v4",
    language: "en"
  },
  global_basketball: {
    label: "Global Basketball",
    base: "https://api.sportradar.com/basketball",
    version: "v2",
    language: "en"
  },
  global_baseball: {
    label: "Global Baseball",
    base: "https://api.sportradar.com/baseball",
    version: "v2",
    language: "en"
  }
};
// Sports that currently feed the real scoring/edge engine.
// Everything else returns route_ready enrichment data only.
var SPORTRADAR_SCORING_ENABLED_SPORTS = ["mlb"];
// Sportradar Odds Comparison Player Props API base (separate product
// from the per-sport stats APIs above).
var SPORTRADAR_PLAYER_PROPS_BASE = "https://api.sportradar.com/oddscomparison-player-props";
var SPORTRADAR_PLAYER_PROPS_VERSION = "v2";

var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400"
};
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/lineup-check") {
      const result = await checkLineups(env);
      return jsonResponse(result);
    }
    if (url.pathname === "/lineup-status") {
      const playerName = url.searchParams.get("player");
      if (!playerName) return jsonResponse({ status: "ERROR", reason: "Missing player param" }, 400);
      const result = await getPlayerLineupStatus(playerName, env);
      return jsonResponse(result);
    }
    if (url.pathname === "/lineup-bulk") {
      try {
        const body = await request.json();
        const players = body.players || [];
        const results = {};
        for (const name of players) {
          results[name] = await getPlayerLineupStatus(name, env);
        }
        return jsonResponse(results);
      } catch (e) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
    }
    if (url.pathname === "/snapshot-props") {
      try {
        const body = await request.json();
        const result = await savePropsSnapshot(body.props || [], env);
        return jsonResponse(result);
      } catch (e) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
    }
    if (url.pathname === "/closing-lines") {
      const gameDate = url.searchParams.get("date") || getTodayDateString();
      const result = await getClosingLines(gameDate, env);
      return jsonResponse(result);
    }
    if (url.pathname === "/api-status") {
      return handleApiStatus();
    }
    if (url.pathname === "/odds/mlb/events") {
      return handleOddsMlbEvents(url);
    }
    if (url.pathname === "/odds/mlb/player-props") {
      return handleOddsMlbPlayerProps(url);
    }
    if (url.pathname === "/sportsdataio/mlb/games") {
      return handleSportsDataIOGames(url);
    }
    if (url.pathname === "/sportsdataio/mlb/lineups") {
      return handleSportsDataIOLineups(url);
    }
    if (url.pathname === "/sportsdataio/mlb/injuries") {
      return handleSportsDataIOInjuries(url);
    }
    if (url.pathname === "/sportsdataio/mlb/projections") {
      return handleSportsDataIOProjections(url);
    }
    if (url.pathname === "/weather/game") {
      return handleOpenWeatherGame(url);
    }
    if (url.pathname === "/sportradar/mlb/schedule") {
      return handleSportradarSchedule(url);
    }
    if (url.pathname === "/sportradar/mlb/game-summary") {
      return handleSportradarGameSummary(url);
    }
    if (url.pathname === "/sportradar/mlb/injuries") {
      return handleSportradarInjuries(url);
    }
    if (url.pathname === "/sportradar/status") {
      return handleSportradarStatus();
    }
    if (url.pathname.startsWith("/sportradar/") && url.pathname.endsWith("/schedule")) {
      return handleSportradarMultiSportSchedule(url);
    }
    if (url.pathname.startsWith("/sportradar/") && url.pathname.endsWith("/summary")) {
      return handleSportradarMultiSportSummary(url);
    }
    if (url.pathname.startsWith("/sportradar/") && url.pathname.endsWith("/team-profile")) {
      return handleSportradarTeamProfile(url);
    }
    if (url.pathname.startsWith("/sportradar/") && url.pathname.endsWith("/player-profile")) {
      return handleSportradarPlayerProfile(url);
    }
    if (url.pathname === "/sportradar/odds/player-props") {
      return handleSportradarPlayerProps(url);
    }
    if (url.pathname === "/ai") {
      return handleAI(request);
    }
    return handleProxy(url);
  },
  // ---- CRON HANDLER ----
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};
async function handleAI(request) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  const workerStartTime = Date.now();
  const WORKER_BUDGET_MS = 27e4;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const systemPrompt = body.systemPrompt || "";
  const userPrompt = body.userPrompt || body.prompt || "";
  const temperature = body.temperature || 0.3;
  const requestedMaxTokens = body.maxTokens || 8e3;
  if (!userPrompt) {
    return jsonResponse({ error: "Missing prompt / userPrompt" }, 400);
  }
  const deepseekMaxTokens = Math.max(requestedMaxTokens, MIN_DEEPSEEK_MAX_TOKENS);
  console.log("[WORKER] budget: 5min mode | requestedMaxTokens:", requestedMaxTokens, "deepseekMaxTokens:", deepseekMaxTokens);
  let geminiError = null;
  try {
    const geminiController = new AbortController();
    const geminiTimeout = setTimeout(() => geminiController.abort(), 12e4);
    const combinedPrompt = systemPrompt ? systemPrompt + "\n\n" + userPrompt : userPrompt;
    const geminiBody = {
      contents: [{ parts: [{ text: combinedPrompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (systemPrompt) {
      geminiBody.system_instruction = { parts: [{ text: systemPrompt }] };
      geminiBody.contents = [{ parts: [{ text: userPrompt }] }];
    }
    console.log("[GEMINI] starting (primary, 120s timeout), t=" + (Date.now() - workerStartTime) + "ms");
    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify(geminiBody),
      signal: geminiController.signal
    });
    clearTimeout(geminiTimeout);
    console.log("[GEMINI] status:", geminiResponse.status, "t=" + (Date.now() - workerStartTime) + "ms");
    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.log("[GEMINI] error body:", errText.substring(0, 500));
      geminiError = "HTTP " + geminiResponse.status + ": " + errText.substring(0, 200);
      throw new Error(geminiError);
    }
    const geminiData = await geminiResponse.json();
    const geminiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!geminiText) {
      console.log("[GEMINI] empty candidates:", JSON.stringify(geminiData?.candidates || []).substring(0, 300));
      geminiError = "Empty Gemini response (possible safety filter)";
      throw new Error(geminiError);
    }
    console.log("[GEMINI] SUCCESS length:", geminiText.length, "t=" + (Date.now() - workerStartTime) + "ms");
    return jsonResponse({
      text: geminiText,
      provider: "gemini",
      model: "gemini-2.5-flash",
      elapsed: Date.now() - workerStartTime
    });
  } catch (err) {
    geminiError = geminiError || err.name + ": " + err.message;
    console.log("[GEMINI FAILED]", geminiError, "t=" + (Date.now() - workerStartTime) + "ms");
  }
  const remainingTime = WORKER_BUDGET_MS - (Date.now() - workerStartTime);
  console.log("[DEEPSEEK] entering fallback, remaining:", remainingTime + "ms");
  if (remainingTime < 5e3) {
    return jsonResponse({
      error: "Both providers failed. Gemini: " + geminiError + ". Insufficient time for DeepSeek.",
      geminiError
    }, 504);
  }
  try {
    const dsController = new AbortController();
    const dsTimeout = setTimeout(() => dsController.abort(), Math.min(remainingTime - 1e3, 12e4));
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    } else {
      messages.push({ role: "system", content: "You are a sports betting analyst. Always respond with valid JSON only, no markdown." });
    }
    messages.push({ role: "user", content: userPrompt });
    const dsBody = {
      model: "deepseek-chat",
      messages,
      temperature,
      max_tokens: deepseekMaxTokens,
      response_format: { type: "json_object" }
    };
    console.log("[DEEPSEEK] starting fallback, max_tokens:", deepseekMaxTokens, "t=" + (Date.now() - workerStartTime) + "ms");
    const dsResponse = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + DEEPSEEK_API_KEY
      },
      body: JSON.stringify(dsBody),
      signal: dsController.signal
    });
    clearTimeout(dsTimeout);
    console.log("[DEEPSEEK] status:", dsResponse.status, "t=" + (Date.now() - workerStartTime) + "ms");
    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      console.log("[DEEPSEEK] error body:", errText.substring(0, 500));
      return jsonResponse({
        error: "DeepSeek HTTP " + dsResponse.status + ": " + errText.substring(0, 200),
        geminiError
      }, 502);
    }
    const dsData = await dsResponse.json();
    const dsText = dsData?.choices?.[0]?.message?.content;
    const finishReason = dsData?.choices?.[0]?.finish_reason;
    if (!dsText) {
      return jsonResponse({ error: "Empty DeepSeek response", geminiError }, 502);
    }
    console.log("[DEEPSEEK] SUCCESS length:", dsText.length, "finish_reason:", finishReason, "t=" + (Date.now() - workerStartTime) + "ms");
    if (finishReason === "length") {
      console.log("[DEEPSEEK WARNING] hit max_tokens limit — response may be truncated");
    }
    return jsonResponse({
      text: dsText,
      provider: "deepseek",
      model: "deepseek-chat",
      finishReason,
      geminiError,
      elapsed: Date.now() - workerStartTime
    });
  } catch (err) {
    console.log("[DEEPSEEK FAILED]", err.name, err.message, "t=" + (Date.now() - workerStartTime) + "ms");
    return jsonResponse({
      error: "Both providers failed. Gemini: " + geminiError + ". DeepSeek: " + err.message,
      geminiError,
      deepseekError: err.message
    }, 502);
  }
}
__name(handleAI, "handleAI");
async function handleProxy(url) {
  const target = url.searchParams.get("url");
  const league = url.searchParams.get("league");
  if (!target) return new Response("Missing url param", { status: 400, headers: CORS_HEADERS });
  const isSharp = target.includes("sharpapi.io");
  const isApify = target.includes("apify.com");
  const isParlay = target.includes("parlay-api.com");
  const fetchHeaders = {};
  if (isSharp) fetchHeaders["X-API-Key"] = SHARP_API_KEY;
  if (isParlay) fetchHeaders["X-API-Key"] = PARLAY_API_KEY;
  if (isApify) fetchHeaders["Content-Type"] = "application/json";
  let fetchMethod = "GET";
  let fetchBody = void 0;
  if (isApify && league) {
    fetchMethod = "POST";
    fetchBody = JSON.stringify({ leagues: [league] });
  }
  const resp = await fetch(target, {
    method: fetchMethod,
    headers: fetchHeaders,
    body: fetchBody
  });
  const respBody = await resp.text();
  return new Response(respBody, {
    status: resp.status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}
__name(handleProxy, "handleProxy");
async function handleScheduled(event, env) {
  console.log("Cron fired at " + (/* @__PURE__ */ new Date()).toISOString());
  const lineupResult = await checkLineups(env);
  console.log("Lineup check: " + lineupResult.confirmed + " confirmed, " + lineupResult.notConfirmed + " pending");
}
__name(handleScheduled, "handleScheduled");
async function checkLineups(env) {
  const today = getTodayDateString();
  const scheduleRes = await fetch(
    MLB_STATS_BASE + "/schedule?sportId=1&date=" + today + "&hydrate=probablePitcher,lineups"
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
    const awayTeam = game.teams?.away?.team?.name || "Unknown";
    const homeTeam = game.teams?.home?.team?.name || "Unknown";
    let awayLineup = [];
    let homeLineup = [];
    try {
      const boxRes = await fetch(MLB_STATS_BASE + "/game/" + gameId + "/boxscore");
      const box = await boxRes.json();
      awayLineup = extractLineup(box?.teams?.away);
      homeLineup = extractLineup(box?.teams?.home);
    } catch (e) {
    }
    const awayPitcher = game.teams?.away?.probablePitcher;
    const homePitcher = game.teams?.home?.probablePitcher;
    if (awayPitcher) {
      playerStatuses.push({
        playerId: awayPitcher.id,
        playerName: awayPitcher.fullName,
        team: awayTeam,
        opponent: homeTeam,
        gameId,
        gameTime,
        role: "pitcher",
        lineupStatus: "CONFIRMED",
        battingOrder: null,
        lastChecked: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    if (homePitcher) {
      playerStatuses.push({
        playerId: homePitcher.id,
        playerName: homePitcher.fullName,
        team: homeTeam,
        opponent: awayTeam,
        gameId,
        gameTime,
        role: "pitcher",
        lineupStatus: "CONFIRMED",
        battingOrder: null,
        lastChecked: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    for (const batter of [...awayLineup, ...homeLineup]) {
      playerStatuses.push({
        playerId: batter.id,
        playerName: batter.fullName,
        team: batter.team,
        opponent: batter.team === awayTeam ? homeTeam : awayTeam,
        gameId,
        gameTime,
        role: "batter",
        lineupStatus: "CONFIRMED",
        battingOrder: batter.battingOrder,
        lastChecked: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  if (env.LINEUP_KV) {
    await env.LINEUP_KV.put(
      "lineups:" + today,
      JSON.stringify(playerStatuses),
      { expirationTtl: 86400 }
    );
  }
  const confirmed = playerStatuses.filter((p) => p.lineupStatus === "CONFIRMED").length;
  return {
    date: today,
    games: games.length,
    confirmed,
    notConfirmed: 0,
    players: playerStatuses,
    lastChecked: (/* @__PURE__ */ new Date()).toISOString()
  };
}
__name(checkLineups, "checkLineups");
function extractLineup(teamBox) {
  if (!teamBox?.battingOrder || teamBox.battingOrder.length === 0) return [];
  const players = teamBox.players || {};
  return teamBox.battingOrder.map((playerId, idx) => {
    const player = players["ID" + playerId] || {};
    return {
      id: playerId,
      fullName: player.person?.fullName || "Player " + playerId,
      team: teamBox.team?.name || "Unknown",
      battingOrder: idx + 1
    };
  });
}
__name(extractLineup, "extractLineup");
async function getPlayerLineupStatus(playerName, env) {
  if (!env.LINEUP_KV) {
    return { status: "NOT_CONFIRMED", reason: "KV not configured" };
  }
  const today = getTodayDateString();
  const data = await env.LINEUP_KV.get("lineups:" + today, "json");
  if (!data) {
    return { status: "NOT_CONFIRMED", reason: "No lineup data yet — cron may not have run" };
  }
  const nameLower = playerName.toLowerCase().trim();
  let match = data.find((p) => p.playerName.toLowerCase() === nameLower);
  if (!match) {
    match = data.find((p) => {
      const parts = nameLower.split(" ").filter((w) => w.length > 2);
      return parts.every((part) => p.playerName.toLowerCase().includes(part));
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
      lastChecked: match.lastChecked
    };
  }
  return { status: "NOT_CONFIRMED", reason: "Player not found in confirmed lineups" };
}
__name(getPlayerLineupStatus, "getPlayerLineupStatus");
async function savePropsSnapshot(props, env) {
  if (!env.LINEUP_KV || !props.length) {
    return { saved: 0, reason: !env.LINEUP_KV ? "KV not configured" : "No props provided" };
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const today = getTodayDateString();
  let saved = 0;
  for (const prop of props) {
    const key = "prop:" + today + ":" + (prop.playerId || prop.playerName) + ":" + prop.propType + ":" + timestamp;
    await env.LINEUP_KV.put(key, JSON.stringify({
      ...prop,
      timestamp,
      gameDate: today
    }), { expirationTtl: 172800 });
    saved++;
  }
  for (const prop of props) {
    const latestKey = "latest:" + today + ":" + (prop.playerId || prop.playerName) + ":" + prop.propType;
    await env.LINEUP_KV.put(latestKey, JSON.stringify({
      ...prop,
      timestamp,
      gameDate: today
    }), { expirationTtl: 172800 });
  }
  return { saved, timestamp };
}
__name(savePropsSnapshot, "savePropsSnapshot");
async function getClosingLines(gameDate, env) {
  if (!env.LINEUP_KV) {
    return { error: "KV not configured" };
  }
  const list = await env.LINEUP_KV.list({ prefix: "latest:" + gameDate + ":" });
  const closingLines = [];
  for (const key of list.keys) {
    const data = await env.LINEUP_KV.get(key.name, "json");
    if (data) closingLines.push(data);
  }
  return { gameDate, count: closingLines.length, lines: closingLines };
}
__name(getClosingLines, "getClosingLines");
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}
__name(jsonResponse, "jsonResponse");
function getTodayDateString() {
  const now = /* @__PURE__ */ new Date();
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const year = eastern.getFullYear();
  const month = String(eastern.getMonth() + 1).padStart(2, "0");
  const day = String(eastern.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}
__name(getTodayDateString, "getTodayDateString");
async function handleApiStatus() {
  return jsonResponse({
    hasTheOddsApi: !!THE_ODDS_API_KEY,
    hasSportsDataIO: !!SPORTSDATAIO_MLB_API_KEY,
    hasOpenWeather: !!OPENWEATHER_API_KEY,
    hasSportradar: !!SPORTRADAR_API_KEY,
    hasGemini: !!GEMINI_API_KEY,
    hasDeepSeek: !!DEEPSEEK_API_KEY,
    hasSharp: !!SHARP_API_KEY,
    hasParlay: !!PARLAY_API_KEY,
    sportradarAccessLevel: SPORTRADAR_ACCESS_LEVEL || "trial",
    sportradarLanguage: SPORTRADAR_LANGUAGE_CODE || "en",
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
__name(handleApiStatus, "handleApiStatus");
async function handleOddsMlbEvents(url) {
  const apiKey = THE_ODDS_API_KEY;
  if (!apiKey) return providerResponse("The Odds API", "skipped", [], "Missing THE_ODDS_API_KEY");
  const regions = url.searchParams.get("regions") || "us";
  const oddsFormat = url.searchParams.get("oddsFormat") || "american";
  const target = THE_ODDS_BASE + "/sports/baseball_mlb/events?" + new URLSearchParams({ apiKey, regions, oddsFormat }).toString();
  const started = Date.now();
  try {
    const data = await fetchJson(target);
    const events = Array.isArray(data) ? data : [];
    console.log("[API RESULT]", { provider: "The Odds API", route: url.pathname, status: "success", count: events.length, elapsedMs: Date.now() - started });
    return jsonResponse({ source: "The Odds API", status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: events.length, events });
  } catch (e) {
    return providerError("The Odds API", e);
  }
}
__name(handleOddsMlbEvents, "handleOddsMlbEvents");
async function handleOddsMlbPlayerProps(url) {
  const apiKey = THE_ODDS_API_KEY;
  if (!apiKey) return providerResponse("The Odds API", "skipped", [], "Missing THE_ODDS_API_KEY");
  const regions = url.searchParams.get("regions") || "us";
  const oddsFormat = url.searchParams.get("oddsFormat") || "american";
  const eventId = url.searchParams.get("eventId");
  const maxEvents = parseInt(url.searchParams.get("maxEvents") || "4") || 4;
  const markets = url.searchParams.get("markets") || defaultOddsMarkets().join(",");
  const started = Date.now();
  try {
    let eventOdds = [];
    if (eventId) {
      eventOdds = [await fetchOddsForEvent(eventId, apiKey, regions, oddsFormat, markets)];
    } else {
      const eventsUrl = THE_ODDS_BASE + "/sports/baseball_mlb/events?" + new URLSearchParams({ apiKey }).toString();
      const events = await fetchJson(eventsUrl);
      const selectedEvents = (Array.isArray(events) ? events : []).slice(0, maxEvents);
      for (const event of selectedEvents) {
        try {
          eventOdds.push(await fetchOddsForEvent(event.id, apiKey, regions, oddsFormat, markets));
        } catch (e) {
          console.log("[ODDS EVENT FAILED]", event.id, e.message);
        }
      }
    }
    const props = normalizeOddsApiProps(eventOdds);
    const aggregated = aggregateOddsProps(props);
    console.log("[API RESULT]", { provider: "The Odds API", route: url.pathname, status: "success", count: props.length, elapsedMs: Date.now() - started });
    return jsonResponse({
      source: "The Odds API",
      status: "success",
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      rawCount: eventOdds.length,
      normalizedCount: props.length,
      aggregatedCount: aggregated.length,
      props,
      aggregated
    });
  } catch (e) {
    return providerError("The Odds API", e);
  }
}
__name(handleOddsMlbPlayerProps, "handleOddsMlbPlayerProps");
async function fetchOddsForEvent(eventId, apiKey, regions, oddsFormat, markets) {
  const target = THE_ODDS_BASE + "/sports/baseball_mlb/events/" + encodeURIComponent(eventId) + "/odds?" + new URLSearchParams({ apiKey, regions, oddsFormat, markets }).toString();
  return fetchJson(target);
}
__name(fetchOddsForEvent, "fetchOddsForEvent");
async function handleSportsDataIOGames(url) {
  const apiKey = SPORTSDATAIO_MLB_API_KEY;
  if (!apiKey) return providerResponse("SportsDataIO", "skipped", [], "Missing SPORTSDATAIO_MLB_API_KEY");
  const date = url.searchParams.get("date") || getTodayDateString();
  return sportsDataIOFetch("SportsDataIO", "/scores/json/GamesByDate/" + date, apiKey, (data) => ({ games: Array.isArray(data) ? data : [] }));
}
__name(handleSportsDataIOGames, "handleSportsDataIOGames");
async function handleSportsDataIOLineups(url) {
  const apiKey = SPORTSDATAIO_MLB_API_KEY;
  if (!apiKey) return providerResponse("SportsDataIO", "skipped", [], "Missing SPORTSDATAIO_MLB_API_KEY");
  const date = url.searchParams.get("date") || getTodayDateString();
  return sportsDataIOFetch("SportsDataIO", "/projections/json/StartingLineupsByDate/" + date, apiKey, (data) => ({ players: normalizeSportsDataIOLineups(data) }));
}
__name(handleSportsDataIOLineups, "handleSportsDataIOLineups");
async function handleSportsDataIOInjuries(url) {
  const apiKey = SPORTSDATAIO_MLB_API_KEY;
  if (!apiKey) return providerResponse("SportsDataIO", "skipped", [], "Missing SPORTSDATAIO_MLB_API_KEY");
  return sportsDataIOFetch("SportsDataIO", "/scores/json/Injuries", apiKey, (data) => ({ injuries: normalizeSportsDataIOInjuries(data) }));
}
__name(handleSportsDataIOInjuries, "handleSportsDataIOInjuries");
async function handleSportsDataIOProjections(url) {
  const apiKey = SPORTSDATAIO_MLB_API_KEY;
  if (!apiKey) return providerResponse("SportsDataIO", "skipped", [], "Missing SPORTSDATAIO_MLB_API_KEY");
  const date = url.searchParams.get("date") || getTodayDateString();
  return sportsDataIOFetch("SportsDataIO", "/projections/json/PlayerGameProjectionStatsByDate/" + date, apiKey, (data) => ({ projections: normalizeSportsDataIOProjections(data) }));
}
__name(handleSportsDataIOProjections, "handleSportsDataIOProjections");
async function sportsDataIOFetch(source, path, apiKey, normalizer) {
  const target = SPORTSDATAIO_BASE + path + "?" + new URLSearchParams({ key: apiKey }).toString();
  const started = Date.now();
  try {
    const data = await fetchJson(target);
    const normalized = normalizer(data);
    const firstKey = Object.keys(normalized)[0];
    const count = Array.isArray(normalized[firstKey]) ? normalized[firstKey].length : 0;
    console.log("[API RESULT]", { provider: source, path, status: "success", count, elapsedMs: Date.now() - started });
    return jsonResponse({ source, status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count, ...normalized });
  } catch (e) {
    if (String(e.message || "").includes("404")) return jsonResponse({ source, status: "unavailable", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: 0, error: e.message });
    return providerError(source, e);
  }
}
__name(sportsDataIOFetch, "sportsDataIOFetch");
async function handleOpenWeatherGame(url) {
  const apiKey = OPENWEATHER_API_KEY;
  if (!apiKey) return providerResponse("OpenWeather", "skipped", [], "Missing OPENWEATHER_API_KEY");
  const city = url.searchParams.get("city");
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  const stadium = url.searchParams.get("stadium") || null;
  if (!city && (!lat || !lon)) return jsonResponse({ source: "OpenWeather", status: "failed", error: "Missing city or lat/lon" }, 400);
  const params = lat && lon ? { lat, lon, appid: apiKey, units: "imperial" } : { q: city, appid: apiKey, units: "imperial" };
  const target = OPENWEATHER_BASE + "/weather?" + new URLSearchParams(params).toString();
  try {
    const data = await fetchJson(target);
    const weather = normalizeOpenWeather(data, stadium);
    return jsonResponse({ source: "OpenWeather", status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), weather });
  } catch (e) {
    return providerError("OpenWeather", e);
  }
}
__name(handleOpenWeatherGame, "handleOpenWeatherGame");

// ---- Existing MLB-only Sportradar handlers (unchanged paths/behavior) ----
async function handleSportradarSchedule(url) {
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar", "skipped", [], "Missing SPORTRADAR_API_KEY");
  const date = url.searchParams.get("date") || getTodayDateString();
  const access = SPORTRADAR_ACCESS_LEVEL || "trial";
  const language = SPORTRADAR_LANGUAGE_CODE || "en";
  const [year, month, day] = date.split("-");
  const target = SPORTRADAR_BASE + "/" + access + "/v8/" + language + "/games/" + year + "/" + month + "/" + day + "/schedule.json?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    const games = normalizeSportradarSchedule(data);
    return jsonResponse({ source: "Sportradar", status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: games.length, games });
  } catch (e) {
    return providerError("Sportradar", e);
  }
}
__name(handleSportradarSchedule, "handleSportradarSchedule");
async function handleSportradarGameSummary(url) {
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar", "skipped", [], "Missing SPORTRADAR_API_KEY");
  const gameId = url.searchParams.get("gameId");
  if (!gameId) return jsonResponse({ source: "Sportradar", status: "failed", error: "Missing gameId" }, 400);
  const access = SPORTRADAR_ACCESS_LEVEL || "trial";
  const language = SPORTRADAR_LANGUAGE_CODE || "en";
  const target = SPORTRADAR_BASE + "/" + access + "/v8/" + language + "/games/" + encodeURIComponent(gameId) + "/summary.json?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    return jsonResponse({ source: "Sportradar", status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), game: normalizeSportradarGameSummary(data), raw: data });
  } catch (e) {
    return providerError("Sportradar", e);
  }
}
__name(handleSportradarGameSummary, "handleSportradarGameSummary");
async function handleSportradarInjuries(url) {
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar", "skipped", [], "Missing SPORTRADAR_API_KEY");
  const access = SPORTRADAR_ACCESS_LEVEL || "trial";
  const language = SPORTRADAR_LANGUAGE_CODE || "en";
  const target = SPORTRADAR_BASE + "/" + access + "/v8/" + language + "/league/injuries.json?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    const injuries = normalizeSportradarInjuries(data);
    return jsonResponse({ source: "Sportradar", status: "success", fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: injuries.length, injuries });
  } catch (e) {
    return providerError("Sportradar", e);
  }
}
__name(handleSportradarInjuries, "handleSportradarInjuries");

// ---- NEW: Multi-sport Sportradar handlers ----
function getSportradarConfig(sport) {
  const key = String(sport || "").toLowerCase().trim();
  return SPORTRADAR_SPORT_CONFIG[key] || null;
}
__name(getSportradarConfig, "getSportradarConfig");
function normalizeSportradarSport(sport) {
  return String(sport || "").toLowerCase().trim();
}
__name(normalizeSportradarSport, "normalizeSportradarSport");
function buildSportradarUrl(sport, path) {
  const cfg = getSportradarConfig(sport);
  if (!cfg) return null;
  const access = SPORTRADAR_ACCESS_LEVEL || "trial";
  return cfg.base + "/" + access + "/" + cfg.version + "/" + (cfg.language || SPORTRADAR_LANGUAGE_CODE || "en") + path;
}
__name(buildSportradarUrl, "buildSportradarUrl");
function unsupportedSportResponse(sport) {
  return jsonResponse({
    source: "Sportradar",
    status: "failed",
    error: "Unsupported sport: " + sport,
    supportedSports: Object.keys(SPORTRADAR_SPORT_CONFIG)
  }, 400);
}
__name(unsupportedSportResponse, "unsupportedSportResponse");
function extractSportFromPath(pathname, suffix) {
  // /sportradar/<sport>/<suffix>
  const parts = pathname.split("/").filter(Boolean);
  // parts = ["sportradar", "<sport>", "<suffix>"]
  if (parts.length < 3) return null;
  return parts[1];
}
__name(extractSportFromPath, "extractSportFromPath");
async function handleSportradarStatus() {
  return jsonResponse({
    hasSportradarKey: !!SPORTRADAR_API_KEY,
    accessLevel: SPORTRADAR_ACCESS_LEVEL || "trial",
    language: SPORTRADAR_LANGUAGE_CODE || "en",
    enabledSports: Object.keys(SPORTRADAR_SPORT_CONFIG),
    scoringEnabledSports: SPORTRADAR_SCORING_ENABLED_SPORTS,
    routesReady: true,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
__name(handleSportradarStatus, "handleSportradarStatus");
async function handleSportradarMultiSportSchedule(url) {
  const sport = normalizeSportradarSport(extractSportFromPath(url.pathname, "schedule"));
  const cfg = getSportradarConfig(sport);
  if (!cfg) return unsupportedSportResponse(sport);
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar " + cfg.label, "skipped", [], "Missing SPORTRADAR_API_KEY");
  const date = url.searchParams.get("date") || getTodayDateString();
  const [year, month, day] = date.split("-");
  const path = "/games/" + year + "/" + month + "/" + day + "/schedule.json";
  const target = buildSportradarUrl(sport, path) + "?" + new URLSearchParams({ api_key: apiKey }).toString();
  const started = Date.now();
  try {
    const data = await fetchJson(target);
    const games = (data?.games || data?.league?.games || data?.sport_events || []).map((g) => normalizeSportradarGame(g, sport));
    return jsonResponse({
      source: "Sportradar " + cfg.label,
      sport,
      status: "success",
      usedInScoring: SPORTRADAR_SCORING_ENABLED_SPORTS.includes(sport),
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      count: games.length,
      games,
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    return sportradarMultiSportError("Sportradar " + cfg.label, sport, e);
  }
}
__name(handleSportradarMultiSportSchedule, "handleSportradarMultiSportSchedule");
async function handleSportradarMultiSportSummary(url) {
  const sport = normalizeSportradarSport(extractSportFromPath(url.pathname, "summary"));
  const cfg = getSportradarConfig(sport);
  if (!cfg) return unsupportedSportResponse(sport);
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar " + cfg.label, "skipped", [], "Missing SPORTRADAR_API_KEY");
  const gameId = url.searchParams.get("gameId") || url.searchParams.get("matchId");
  if (!gameId) return jsonResponse({ source: "Sportradar " + cfg.label, sport, status: "failed", error: "Missing gameId" }, 400);
  const path = "/games/" + encodeURIComponent(gameId) + "/summary.json";
  const target = buildSportradarUrl(sport, path) + "?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    return jsonResponse({
      source: "Sportradar " + cfg.label,
      sport,
      status: "success",
      usedInScoring: SPORTRADAR_SCORING_ENABLED_SPORTS.includes(sport),
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      game: normalizeSportradarGameSummary(data),
      raw: data
    });
  } catch (e) {
    return sportradarMultiSportError("Sportradar " + cfg.label, sport, e);
  }
}
__name(handleSportradarMultiSportSummary, "handleSportradarMultiSportSummary");
async function handleSportradarTeamProfile(url) {
  const sport = normalizeSportradarSport(extractSportFromPath(url.pathname, "team-profile"));
  const cfg = getSportradarConfig(sport);
  if (!cfg) return unsupportedSportResponse(sport);
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar " + cfg.label, "skipped", [], "Missing SPORTRADAR_API_KEY");
  const teamId = url.searchParams.get("teamId");
  if (!teamId) return jsonResponse({ source: "Sportradar " + cfg.label, sport, status: "failed", error: "Missing teamId" }, 400);
  const path = "/teams/" + encodeURIComponent(teamId) + "/profile.json";
  const target = buildSportradarUrl(sport, path) + "?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    return jsonResponse({
      source: "Sportradar " + cfg.label,
      sport,
      status: "success",
      usedInScoring: SPORTRADAR_SCORING_ENABLED_SPORTS.includes(sport),
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      team: data
    });
  } catch (e) {
    return sportradarMultiSportError("Sportradar " + cfg.label, sport, e);
  }
}
__name(handleSportradarTeamProfile, "handleSportradarTeamProfile");
async function handleSportradarPlayerProfile(url) {
  const sport = normalizeSportradarSport(extractSportFromPath(url.pathname, "player-profile"));
  const cfg = getSportradarConfig(sport);
  if (!cfg) return unsupportedSportResponse(sport);
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar " + cfg.label, "skipped", [], "Missing SPORTRADAR_API_KEY");
  const playerId = url.searchParams.get("playerId");
  if (!playerId) return jsonResponse({ source: "Sportradar " + cfg.label, sport, status: "failed", error: "Missing playerId" }, 400);
  const path = "/players/" + encodeURIComponent(playerId) + "/profile.json";
  const target = buildSportradarUrl(sport, path) + "?" + new URLSearchParams({ api_key: apiKey }).toString();
  try {
    const data = await fetchJson(target);
    return jsonResponse({
      source: "Sportradar " + cfg.label,
      sport,
      status: "success",
      usedInScoring: SPORTRADAR_SCORING_ENABLED_SPORTS.includes(sport),
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      player: normalizeSportradarPlayer(data, sport)
    });
  } catch (e) {
    return sportradarMultiSportError("Sportradar " + cfg.label, sport, e);
  }
}
__name(handleSportradarPlayerProfile, "handleSportradarPlayerProfile");
async function handleSportradarPlayerProps(url) {
  const sport = normalizeSportradarSport(url.searchParams.get("sport") || "mlb");
  const cfg = getSportradarConfig(sport);
  if (!cfg) return unsupportedSportResponse(sport);
  const apiKey = SPORTRADAR_API_KEY;
  if (!apiKey) return providerResponse("Sportradar Odds Player Props", "skipped", [], "Missing SPORTRADAR_API_KEY");
  const market = url.searchParams.get("market");
  const eventId = url.searchParams.get("eventId");
  const book = url.searchParams.get("book");
  const access = SPORTRADAR_ACCESS_LEVEL || "trial";
  let path;
  if (eventId) {
    path = "/" + access + "/" + SPORTRADAR_PLAYER_PROPS_VERSION + "/en/sports/" + sport + "/events/" + encodeURIComponent(eventId) + "/players_props.json";
  } else {
    path = "/" + access + "/" + SPORTRADAR_PLAYER_PROPS_VERSION + "/en/sports/" + sport + "/players_props.json";
  }
  const params = { api_key: apiKey };
  if (market) params.market = market;
  if (book) params.book = book;
  const target = SPORTRADAR_PLAYER_PROPS_BASE + path + "?" + new URLSearchParams(params).toString();
  const started = Date.now();
  try {
    const data = await fetchJson(target);
    const props = normalizeSportradarPlayerPropsResponse(data, sport);
    console.log("[API RESULT]", { provider: "Sportradar Odds Player Props", route: url.pathname, sport, status: "success", count: props.length, elapsedMs: Date.now() - started });
    return jsonResponse({
      source: "Sportradar Odds Player Props",
      sport,
      status: "success",
      usedInScoring: false,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      count: props.length,
      props,
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    return sportradarMultiSportError("Sportradar Odds Player Props", sport, e);
  }
}
__name(handleSportradarPlayerProps, "handleSportradarPlayerProps");
function sportradarMultiSportError(source, sport, e) {
  const message = e?.message || String(e);
  if (message.includes("404") || message.includes("403")) {
    return jsonResponse({
      source,
      sport,
      status: "unavailable",
      usedInScoring: false,
      error: "Endpoint unavailable for this subscription or sport: " + message.substring(0, 200)
    });
  }
  return providerError(source, e);
}
__name(sportradarMultiSportError, "sportradarMultiSportError");
function normalizeSportradarGame(game, sport) {
  return {
    source: "Sportradar",
    sport,
    gameId: game.id,
    status: game.status,
    scheduled: game.scheduled || game.start_time,
    home: game.home?.name || game.home?.market || game.competitors?.[0]?.name || null,
    away: game.away?.name || game.away?.market || game.competitors?.[1]?.name || null,
    venue: game.venue?.name || null,
    raw: game
  };
}
__name(normalizeSportradarGame, "normalizeSportradarGame");
function normalizeSportradarPlayer(data, sport) {
  const player = data?.player || data;
  return {
    sport,
    playerId: player?.id || null,
    fullName: player?.full_name || player?.name || null,
    team: player?.team?.name || null,
    position: player?.position || null,
    raw: player
  };
}
__name(normalizeSportradarPlayer, "normalizeSportradarPlayer");
function normalizeSportradarPlayerPropsResponse(data, sport) {
  const markets = data?.player_props || data?.markets || data?.events || [];
  const props = [];
  for (const event of (Array.isArray(markets) ? markets : [])) {
    const books = event?.books || event?.sportsbooks || [];
    for (const book of books) {
      for (const market of book?.markets || []) {
        for (const outcome of market?.outcomes || market?.books || []) {
          props.push(normalizeSportradarPlayerProp({
            event,
            book,
            market,
            outcome
          }, sport));
        }
      }
    }
  }
  return props;
}
__name(normalizeSportradarPlayerPropsResponse, "normalizeSportradarPlayerPropsResponse");
function normalizeSportradarPlayerProp(raw, sport) {
  const { event, book, market, outcome } = raw;
  return {
    source: "Sportradar Odds Player Props",
    sport,
    eventId: event?.id || null,
    player_name: outcome?.player_name || outcome?.name || null,
    team: outcome?.team || null,
    opponent: event?.opponent || null,
    market: market?.name || market?.key || null,
    stat_type: market?.key || null,
    stat_display: market?.name || null,
    line: outcome?.point ?? outcome?.line ?? null,
    side: outcome?.side || outcome?.name || null,
    american_odds: outcome?.price || outcome?.odds || null,
    sportsbook: book?.name || book?.key || null,
    last_update: market?.last_update || event?.last_update || null
  };
}
__name(normalizeSportradarPlayerProp, "normalizeSportradarPlayerProp");

async function fetchJson(target) {
  const response = await fetch(target);
  const text = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + text.substring(0, 300));
  if (!text) return null;
  return JSON.parse(text);
}
__name(fetchJson, "fetchJson");
function providerResponse(source, status, rows, error) {
  return jsonResponse({ source, status, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: Array.isArray(rows) ? rows.length : 0, error });
}
__name(providerResponse, "providerResponse");
function providerError(source, e) {
  const message = e?.message || String(e);
  let status = "failed";
  if (message.includes("401") || message.includes("403")) status = "unauthorized";
  if (message.includes("429")) status = "rate_limited";
  return jsonResponse({ source, status, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), count: 0, error: message.substring(0, 400) }, 502);
}
__name(providerError, "providerError");
function defaultOddsMarkets() {
  return [
    "batter_hits",
    "batter_total_bases",
    "batter_rbis",
    "batter_runs_scored",
    "batter_hits_runs_rbis",
    "batter_walks",
    "batter_home_runs",
    "pitcher_strikeouts",
    "pitcher_hits_allowed",
    "pitcher_walks",
    "pitcher_earned_runs",
    "pitcher_outs"
  ];
}
__name(defaultOddsMarkets, "defaultOddsMarkets");
function normalizeOddsApiProps(events) {
  const props = [];
  for (const event of events || []) {
    const bookmakers = event?.bookmakers || [];
    for (const book of bookmakers) {
      for (const market of book.markets || []) {
        for (const outcome of market.outcomes || []) {
          const side = normalizeOutcomeSide(outcome.name);
          const playerName = outcome.description || (!side ? outcome.name : "");
          if (!playerName) continue;
          props.push({
            source: "The Odds API",
            event_id: event.id,
            commence_time: event.commence_time,
            home_team: event.home_team,
            away_team: event.away_team,
            bookmaker: book.title || book.key,
            market_key: market.key,
            player_name: playerName,
            stat_type: normalizeStatType(market.key),
            stat_display: statDisplayFromMarket(market.key),
            line: outcome.point ?? null,
            side: side || outcome.name,
            american_odds: outcome.price,
            last_update: market.last_update || book.last_update || null
          });
        }
      }
    }
  }
  return props;
}
__name(normalizeOddsApiProps, "normalizeOddsApiProps");
function aggregateOddsProps(props) {
  const map = {};
  for (const prop of props) {
    const key = [normalizePlayerName(prop.player_name), prop.stat_type, prop.line, String(prop.side).toLowerCase()].join("|");
    if (!map[key]) map[key] = { ...prop, books: [], bookCount: 0, consensusAmericanOdds: null, bestAmericanOdds: null, marketProbability: null };
    map[key].books.push({ bookmaker: prop.bookmaker, american_odds: prop.american_odds, last_update: prop.last_update });
  }
  return Object.values(map).map((item) => {
    const odds = item.books.map((b) => Number(b.american_odds)).filter((n) => !isNaN(n));
    const implied = odds.map(americanToImplied).filter((n) => n != null);
    item.bookCount = item.books.length;
    item.consensusAmericanOdds = odds.length ? Math.round(odds.reduce((a, b) => a + b, 0) / odds.length) : null;
    item.bestAmericanOdds = odds.length ? Math.max(...odds) : null;
    item.marketProbability = implied.length ? implied.reduce((a, b) => a + b, 0) / implied.length : null;
    return item;
  });
}
__name(aggregateOddsProps, "aggregateOddsProps");
function normalizeSportsDataIOLineups(data) {
  const rows = Array.isArray(data) ? data : [];
  const players = [];
  for (const row of rows) {
    for (const side of ["Home", "Away"]) {
      const team = row[side + "Team"] || row[side + "TeamKey"] || row[side + "TeamID"] || null;
      const lineup = row[side + "Lineup"] || row[side + "BattingLineup"] || [];
      if (Array.isArray(lineup)) {
        lineup.forEach((p, idx) => players.push({
          player_name: p.Name || p.PlayerName || p.NameFirstLast || p.FullName,
          team,
          opponent: side === "Home" ? row.AwayTeam : row.HomeTeam,
          battingOrder: p.BattingOrder || idx + 1,
          lineupStatus: row.Status || row.LineupStatus || "UNKNOWN",
          position: p.Position || null,
          handedness: p.Bats || p.Handedness || null,
          gameTime: row.DateTime || row.Day || null,
          opponentPitcher: side === "Home" ? row.AwayStartingPitcher : row.HomeStartingPitcher,
          opponentPitcherHand: side === "Home" ? row.AwayStartingPitcherHand : row.HomeStartingPitcherHand
        }));
      }
    }
  }
  return players.filter((p) => p.player_name);
}
__name(normalizeSportsDataIOLineups, "normalizeSportsDataIOLineups");
function normalizeSportsDataIOInjuries(data) {
  return (Array.isArray(data) ? data : []).map((i) => ({
    player_name: i.Name || i.PlayerName || i.NameFirstLast,
    team: i.Team || i.TeamKey,
    status: i.Status || i.InjuryStatus,
    bodyPart: i.BodyPart || i.InjuryBodyPart,
    notes: i.Notes || i.InjuryNotes || i.Comment,
    updated: i.Updated || i.UpdatedDate || i.LastUpdated
  })).filter((i) => i.player_name);
}
__name(normalizeSportsDataIOInjuries, "normalizeSportsDataIOInjuries");
function normalizeSportsDataIOProjections(data) {
  const rows = Array.isArray(data) ? data : [];
  return rows.map((p) => ({
    player_name: p.Name || p.PlayerName || p.NameFirstLast,
    team: p.Team || p.TeamKey,
    opponent: p.Opponent || p.OpponentKey,
    gameTime: p.DateTime || p.Day,
    raw: p
  })).filter((p) => p.player_name);
}
__name(normalizeSportsDataIOProjections, "normalizeSportsDataIOProjections");
function normalizeOpenWeather(data, stadium) {
  const windSpeedMph = Number(data?.wind?.speed || 0);
  const tempF = data?.main?.temp ?? null;
  const humidity = data?.main?.humidity ?? null;
  const conditions = data?.weather?.[0]?.description || null;
  const rainRisk = data?.rain ? "medium" : "low";
  let hitterBoost = 0;
  let pitcherBoost = 0;
  if (tempF != null && tempF >= 85) hitterBoost += 0.01;
  if (tempF != null && tempF <= 55) pitcherBoost += 0.01;
  if (windSpeedMph >= 10) hitterBoost += 0.01;
  return {
    stadium,
    tempF,
    windSpeedMph,
    windDirection: data?.wind?.deg ?? null,
    humidity,
    precipitationProbability: data?.rain ? 0.35 : 0,
    conditions,
    weatherRisk: rainRisk,
    hitterBoost: Math.min(hitterBoost, 0.04),
    pitcherBoost: Math.min(pitcherBoost, 0.04)
  };
}
__name(normalizeOpenWeather, "normalizeOpenWeather");
function normalizeSportradarSchedule(data) {
  const games = data?.league?.games || data?.games || [];
  return (Array.isArray(games) ? games : []).map((g) => ({
    gameId: g.id,
    status: g.status,
    scheduled: g.scheduled,
    home: g.home?.name || g.home?.market,
    away: g.away?.name || g.away?.market,
    venue: g.venue?.name || null,
    raw: g
  }));
}
__name(normalizeSportradarSchedule, "normalizeSportradarSchedule");
function normalizeSportradarGameSummary(data) {
  return {
    gameId: data?.game?.id || data?.id,
    status: data?.game?.status || data?.status,
    scheduled: data?.game?.scheduled || data?.scheduled,
    home: data?.game?.home || data?.home,
    away: data?.game?.away || data?.away
  };
}
__name(normalizeSportradarGameSummary, "normalizeSportradarGameSummary");
function normalizeSportradarInjuries(data) {
  const teams = data?.league?.teams || data?.teams || [];
  const injuries = [];
  for (const team of teams || []) {
    for (const player of team.players || []) {
      for (const injury of player.injuries || []) {
        injuries.push({
          player_name: player.full_name || player.name,
          team: team.alias || team.name,
          status: injury.status,
          bodyPart: injury.location || null,
          notes: injury.comment || injury.desc || null,
          updated: injury.update_date || null
        });
      }
    }
  }
  return injuries;
}
__name(normalizeSportradarInjuries, "normalizeSportradarInjuries");
function normalizeOutcomeSide(name) {
  const s = String(name || "").toLowerCase().trim();
  if (["over", "higher", "yes"].includes(s)) return "Over";
  if (["under", "lower", "no"].includes(s)) return "Under";
  return null;
}
__name(normalizeOutcomeSide, "normalizeOutcomeSide");
function normalizePlayerName(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
__name(normalizePlayerName, "normalizePlayerName");
function normalizeStatType(stat) {
  const s = String(stat || "").toLowerCase();
  const map = {
    batter_hits: "hits",
    batter_total_bases: "total_bases",
    batter_rbis: "rbis",
    batter_runs_scored: "runs",
    batter_hits_runs_rbis: "hits_runs_rbis",
    batter_walks: "walks",
    batter_home_runs: "home_runs",
    pitcher_strikeouts: "pitcher_strikeouts",
    pitcher_hits_allowed: "hits_allowed",
    pitcher_walks: "walks_allowed",
    pitcher_earned_runs: "earned_runs_allowed",
    pitcher_outs: "pitching_outs"
  };
  return map[s] || s;
}
__name(normalizeStatType, "normalizeStatType");
function statDisplayFromMarket(marketKey) {
  const map = {
    batter_hits: "Hits",
    batter_total_bases: "Total Bases",
    batter_rbis: "RBIs",
    batter_runs_scored: "Runs",
    batter_hits_runs_rbis: "Hits + Runs + RBIs",
    batter_walks: "Walks",
    batter_home_runs: "Home Runs",
    pitcher_strikeouts: "Strikeouts",
    pitcher_hits_allowed: "Hits Allowed",
    pitcher_walks: "Walks Allowed",
    pitcher_earned_runs: "Earned Runs Allowed",
    pitcher_outs: "Pitching Outs"
  };
  return map[marketKey] || marketKey;
}
__name(statDisplayFromMarket, "statDisplayFromMarket");
function americanToImplied(odds) {
  const o = Number(odds);
  if (!o || isNaN(o)) return null;
  if (o < 0) return Math.abs(o) / (Math.abs(o) + 100);
  return 100 / (o + 100);
}
__name(americanToImplied, "americanToImplied");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
