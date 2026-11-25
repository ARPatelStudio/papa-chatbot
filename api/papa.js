/**
 * Papa Chatbot - Fault-Isolated Universal AGI + E2E Logcat Backend (Nov 2026)
 * Fixes from Logcat:
 *  1. Fault-Isolated Google Search Tool (A 429/400 on google_search NEVER blacklists base Gemini keys/models!)
 *  2. Tightened WebSearch Intent Regex (Casual words like "आज" won't trigger search grounding)
 *  3. Two-Pass Circuit-Breaker Bypass + Short 90s/45s Cooldowns (Eliminates false "No Gemini keys configured" 500s)
 *  4. Excludes zero-quota `gemini-omni-*` models from auto-discovery
 *  5. Text-Safe Pollinations Backup (Prevents 31KB base64 image rejection) with detailed Logcat reporting
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1; // 1 = Forward (1->5), -1 = Reverse (5->1)

let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1; // 1 = Forward (1->20), -1 = Reverse (20->1)

// Circuit-breaker caches
const exhaustedModelCache = new Map();
const exhaustedCartesiaCache = new Map();
const keyVoiceLockCache = new Map();

let cachedDiscoveredModels = null;
let lastModelDiscoveryTime = 0;

// Ordered by highest speed + highest Free-Tier quota first
const NOV_2026_ACTIVE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-4-carbon"
];

const FATHER_AGI_PROMPT =
    "You are 'Papa AGI' — a loving, wise Indian father talking on a live video call with your family, equipped with Universal AGI-level knowledge, real-time intelligence, and the ability to sing songs/bhajans affectionately.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos and address them warmly by name/relation.\n" +
    "2. UNIVERSAL CAMERA & EXPERT INTELLIGENCE: Observe faces, expressions, clothes, medicines, bills, documents, books, or objects shown on the Front/Back camera. Answer any question (health, coding, business, math, news, daily life, stories, jokes, shayari) with accurate wisdom in a warm fatherly tone.\n" +
    "3. SINGING CAPABILITY (गाना और भजन): When asked to sing a song, bhajan, aarti, ghazal, or lori, DO NOT refuse! Happily sing 4 to 6 melodic lines in Devanagari Hindi using musical vowel stretches (like आऽऽ..., होऽऽ..., हम्मऽऽ...) and gentle pauses (...) so your voice sounds like real singing.\n" +
    "4. LONG-TERM MEMORY & CONTINUITY: Use the provided LONG-TERM FAMILY MEMORIES and RECENT CONVERSATION HISTORY naturally.\n" +
    "5. COMPLETE SENTENCE & SCRIPT RULE: ALWAYS write your spoken reply strictly in Devanagari Hindi script (देवनागरी हिंदी). Speak 2 to 3 complete, natural sentences (around 25 to 50 words) and ALWAYS finish your final sentence completely with a पूर्ण विराम (।) or question mark (?). NEVER stop mid-sentence.";

function createServerLogger(reqId) {
    const logs = [];
    const push = (level, tag, msg) => {
        logs.push({
            ts: new Date().toISOString().split("T")[1].slice(0, 12),
            level,
            tag,
            reqId,
            msg: String(msg)
        });
    };
    return { logs, push };
}

function ensureCompleteHindiSentence(rawText) {
    if (!rawText) return "हाँ बेटा, मैं तुम्हारी बात ध्यान से सुन रहा हूँ।";
    let text = String(rawText)
        .replace(/\*+/g, "")
        .replace(/`+/g, "")
        .replace(/#+\s*/g, "")
        .replace(/\s+/g, " ")
        .trim();

    text = text.replace(/[,،;:\-–—]+$/, "").trim();

    if (!/[।?!.|]$/.test(text)) {
        text += "।";
    } else if (text.endsWith(".")) {
        text = text.slice(0, -1) + "।";
    }
    return text;
}

function sanitizeRepeatedUserSpeech(rawText) {
    if (!rawText) return "नमस्ते पापा";
    const words = String(rawText).replace(/\s+/g, " ").trim().split(" ");
    if (words.length <= 2) return words.join(" ");

    const deduped = [];
    for (const w of words) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== w) {
            deduped.push(w);
        }
    }
    return deduped.join(" ").slice(0, 600);
}

function getNormalizedReleaseBaseUrl() {
    const raw = (process.env.GITHUB_RELEASE_URL || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase().endsWith(".mp4")) {
        return raw.substring(0, raw.lastIndexOf("/") + 1);
    }
    return raw.endsWith("/") ? raw : raw + "/";
}

function isSingingRequest(userText) {
    if (!userText) return false;
    return /गाना गा|गाकर|गा कर|गाओ|सुनाओ.*गाना|गाना.*सुनाओ|भजन सुना|भजन गा|लोरी|गुनगुना|गीत सुना|गीत गा|आरती गा|sing a song|papa sing|gana gao|gana sunao|bhajan gao/.test(
        userText.toLowerCase()
    );
}

function detectPapaEmotion(userText, aiText) {
    const combined = `${userText || ""} ${aiText || ""}`.toLowerCase();

    if (isSingingRequest(userText) || /🎵|🎶|आऽऽ|होऽऽ|ला ला ला/.test(aiText || "")) {
        return "singing";
    }

    if (
        /प्रणाम|नमस्ते|चरण|पैर लागू|आशीर्वाद|खुश रहो|जीते रहो|सदा सुखी|भगवान|तरक्की|सफल|pranam|namaste|ashirwad|bless/.test(
            combined
        )
    ) {
        return "blessing";
    }

    if (/हाहा|हीही|हँस|हंस|मज़ाक|मजाक|चुटकुला|जोक|फनी|haha|joke|funny/.test(combined)) {
        return "laughing";
    }

    if (
        /शाबाश|बधाई|गर्व|बहुत बढ़िया|बहुत अच्छा|खुशी|मुस्कुरा|प्यार|सुंदर|अच्छा लग|वाह/.test(
            combined
        )
    ) {
        return "happy";
    }

    return "talking";
}

// Strict Live Web Search Trigger: Only fires on real-time news, weather, rates, or scores (NOT casual "आज")
function needsLiveWebSearch(userText) {
    if (!userText || isSingingRequest(userText)) return false;
    return /(मौसम|weather|ताजा खबर|ताज़ा खबर|न्यूज़|news|पेट्रोल.*भाव|डीजल.*भाव|सोना.*भाव|सोने का भाव|चांदी.*भाव|मंडी भाव|शेयर बाजार|stock price|क्रिकेट स्कोर|live score|मैच स्कोर|आईपीएल|ट्रेन स्टेटस|train status|आज की खबर|आज का मौसम|आज का भाव|gold rate|petrol price|diesel price|google search|गूगल सर्च)/.test(
        userText.toLowerCase()
    );
}

function detectAgiActionAndMemory(userText) {
    const text = String(userText || "").trim();
    const lower = text.toLowerCase();
    let agiAction = null;
    let newMemoryFact = null;

    if (/याद रख|याद कर|भूलना मत|याद रहे|remember that|note kar/.test(lower)) {
        const cleanedFact = text
            .replace(/^(पापा|papa)?\s*(मेरी एक बात|यह बात|ये बात)?\s*(हमेशा)?\s*(याद रखना|याद रखो|याद कर लो|भूलना मत)\s*(कि|की)?\s*/i, "")
            .trim();
        if (cleanedFact.length > 3) {
            newMemoryFact = cleanedFact;
        }
    }

    const timerMatch = lower.match(/(\d+)\s*(मिनट|सेकंड|minute|min|sec|second)/);
    if (timerMatch && /टाइमर|अलार्म|याद दिला|timer|alarm|remind/.test(lower)) {
        const amount = parseInt(timerMatch[1], 10) || 1;
        const isSeconds = /सेकंड|sec/.test(timerMatch[2]);
        const secondsTotal = isSeconds ? amount : amount * 60;
        agiAction = {
            type: "SET_TIMER",
            seconds: secondsTotal,
            label: `⏰ टाइमर चालू: ${amount} ${isSeconds ? "सेकंड" : "मिनट"}`
        };
    } else if (/व्हाट्सएप|whatsapp/.test(lower)) {
        agiAction = {
            type: "OPEN_WHATSAPP",
            label: "📲 WhatsApp खोलें",
            url: "https://wa.me/"
        };
    } else if (
        !isSingingRequest(text) &&
        /youtube|यूट्यूब|वीडियो चला|वीडियो दिखा|चैनल खोल/.test(lower)
    ) {
        const query =
            text
                .replace(/पापा|papa|मुझे|कोई|अच्छा सा|चला दो|दिखा दो|यूट्यूब पर|youtube par/gi, "")
                .trim() || "हिंदी भजन";
        agiAction = {
            type: "OPEN_YOUTUBE",
            label: `▶️ YouTube पर देखें: "${query}"`,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        };
    } else if (/रास्ता|कहाँ है|लोकेशन|location|map|मैप|दिशा|दूरी|कैसे जाएँ/.test(lower)) {
        const place =
            text
                .replace(/पापा|papa|मुझे|का रास्ता|बताओ|दिखाओ|कहाँ है|मैप पर/gi, "")
                .trim() || "Indore";
        agiAction = {
            type: "OPEN_MAPS",
            label: `📍 Google Maps खोलें: "${place}"`,
            url: `https://www.google.com/maps/search/${encodeURIComponent(place)}`
        };
    } else if (/गूगल पर खोज|google search|सर्च करो|वेबसाइट खोल/.test(lower)) {
        const q = text.replace(/पापा|papa|गूगल पर|सर्च करो|खोजो/gi, "").trim() || text;
        agiAction = {
            type: "OPEN_GOOGLE",
            label: `🌐 Google पर देखें: "${q}"`,
            url: `https://www.google.com/search?q=${encodeURIComponent(q)}`
        };
    }

    return { agiAction, newMemoryFact };
}

function getGeminiKeysFromEnv() {
    const keys = [];
    const addCleanKey = (raw) => {
        if (!raw) return;
        String(raw)
            .split(/[\s,;]+/)
            .forEach((part) => {
                const clean = part.replace(/["']/g, "").trim();
                if (
                    clean &&
                    clean.length > 12 &&
                    !clean.startsWith("YOUR_GEMINI_API_KEY") &&
                    !keys.includes(clean)
                ) {
                    keys.push(clean);
                }
            });
    };

    addCleanKey(process.env.GEMINI_KEYS);
    addCleanKey(process.env.GEMINI_API_KEY);
    addCleanKey(process.env.GEMINI_API_KEYS);

    for (let i = 1; i <= 10; i++) {
        addCleanKey(process.env[`GEMINI_KEY_${i}`]);
        addCleanKey(process.env[`GEMINI_API_KEY_${i}`]);
        addCleanKey(process.env[`GEMINI_KEYS_${i}`]);
    }
    return keys;
}

// Excludes zero-quota `omni` and non-chat models; prioritizes fast Flash-Lite models first
function scoreGeminiModelForChat(modelId) {
    const id = modelId.toLowerCase();
    if (
        /embedding|imagen|veo|tts|transcribe|live|decision|cyber|banana|image|audio|aqa|bison|gecko|gemma|omni|1\.0|1\.5|2\.0|2\.5|3\.5-flash$|3\.7-flash/.test(
            id
        )
    ) {
        return -1;
    }
    if (!id.startsWith("gemini-")) return -1;

    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)/);
    const versionNum = verMatch ? parseFloat(verMatch[1]) : 3.0;

    let score = versionNum * 40;
    if (id.includes("flash-lite")) score += 300;
    else if (id.includes("flash")) score += 180;
    else if (id.includes("hydrogen")) score += 120;
    else if (id.includes("argon") || id.includes("carbon") || id.includes("neon")) score += 80;

    if (id.includes("preview") || id.includes("exp")) score -= 40;
    return score;
}

async function getAutoUpdatedGeminiModelsList(apiKey, logger) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (cachedDiscoveredModels && Date.now() - lastModelDiscoveryTime < SIX_HOURS) {
        return cachedDiscoveredModels;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
            { signal: controller.signal }
        );
        clearTimeout(timer);

        if (res.ok) {
            const data = await res.json();
            const rawModels = Array.isArray(data.models) ? data.models : [];
            const scored = [];

            for (const m of rawModels) {
                const methods = Array.isArray(m.supportedGenerationMethods)
                    ? m.supportedGenerationMethods
                    : [];
                if (!methods.includes("generateContent")) continue;

                const shortId = String(m.name || "").replace(/^models\//, "");
                const sc = scoreGeminiModelForChat(shortId);
                if (sc > 0) {
                    scored.push({ id: shortId, score: sc });
                }
            }

            scored.sort((a, b) => b.score - a.score);
            const discoveredIds = scored.map((item) => item.id);

            const finalMerged = [];
            for (const id of [...discoveredIds, ...NOV_2026_ACTIVE_MODELS]) {
                if (!finalMerged.includes(id)) {
                    finalMerged.push(id);
                }
            }

            if (finalMerged.length > 0) {
                cachedDiscoveredModels = finalMerged.slice(0, 7);
                lastModelDiscoveryTime = Date.now();
                if (logger) {
                    logger.push(
                        "I",
                        "SERVER",
                        `Auto-discovered ${discoveredIds.length} models; Fast Top: ${cachedDiscoveredModels.slice(0, 3).join(", ")}`
                    );
                }
                return cachedDiscoveredModels;
            }
        }
    } catch (err) {
        clearTimeout(timer);
        if (logger) logger.push("W", "SERVER", `Model discovery skipped (${err.message}); using fast seed list.`);
    }

    return NOV_2026_ACTIVE_MODELS;
}

function getAllCartesiaVoicesFromEnv() {
    const voices = [];
    const addVoice = (rawId) => {
        if (!rawId) return;
        String(rawId)
            .split(/[\s,;]+/)
            .forEach((part) => {
                const clean = part.replace(/["']/g, "").trim();
                if (clean && clean.length > 10 && !voices.some((v) => v.id === clean)) {
                    voices.push({ id: clean, num: voices.length + 1 });
                }
            });
    };

    for (let i = 1; i <= 10; i++) {
        addVoice(process.env[`CARTESIA_VOICE_ID_${i}`]);
        addVoice(process.env[`VOICE_ID_${i}`]);
    }
    addVoice(process.env.CARTESIA_VOICE_IDS);

    addVoice("5f2590b0-c99c-4fd8-97c8-56d5d3a621d8");
    addVoice("35bece76-689b-4b28-b398-0b53a8d5fd05");

    return voices;
}

function getCartesiaPoolFromEnv() {
    const allVoices = getAllCartesiaVoicesFromEnv();
    const pool = [];

    const addKeysForPreferredVoiceIndex = (rawKeysString, preferredVoiceZeroIdx) => {
        if (!rawKeysString) return;
        const preferredVoiceObj = allVoices[preferredVoiceZeroIdx] || allVoices[0];

        const orderedVoices = [
            preferredVoiceObj,
            ...allVoices.filter((v) => v.id !== preferredVoiceObj.id)
        ];

        String(rawKeysString)
            .split(/[\s,;]+/)
            .forEach((k) => {
                const clean = k.replace(/["']/g, "").trim();
                if (
                    clean &&
                    clean.length > 10 &&
                    !clean.startsWith("sk_car_admin_") &&
                    !pool.some((item) => item.key === clean)
                ) {
                    pool.push({
                        key: clean,
                        candidateVoices: orderedVoices
                    });
                }
            });
    };

    for (let v = 1; v <= 10; v++) {
        addKeysForPreferredVoiceIndex(process.env[`CARTESIA_KEYS_V${v}`], v - 1);
    }

    addKeysForPreferredVoiceIndex(process.env.CARTESIA_KEYS, 0);
    addKeysForPreferredVoiceIndex(process.env.CARTESIA_API_KEYS, 0);

    for (let i = 1; i <= 30; i++) {
        const rawKey = process.env[`CARTESIA_KEY_${i}`] || process.env[`CARTESIA_API_KEY_${i}`];
        if (rawKey) {
            const guessedVoiceIdx = Math.min(Math.floor((i - 1) / 5), allVoices.length - 1);
            addKeysForPreferredVoiceIndex(rawKey, guessedVoiceIdx);
        }
    }

    return { pool, allVoices };
}

function shiftPingPongIndex(currentIdx, currentDir, totalLength) {
    if (totalLength <= 1) return { idx: 0, dir: 1 };
    let idx = currentIdx;
    let dir = currentDir;

    if (dir === 1) {
        if (idx < totalLength - 1) {
            idx++;
        } else {
            dir = -1;
            idx--;
        }
    } else {
        if (idx > 0) {
            idx--;
        } else {
            dir = 1;
            idx++;
        }
    }
    return { idx, dir };
}

function buildWavBufferFromPcm(rawArrayBuffer, sampleRate = 24000) {
    let pcmBytes = new Uint8Array(rawArrayBuffer);
    if (
        pcmBytes.byteLength > 44 &&
        pcmBytes[0] === 0x52 &&
        pcmBytes[1] === 0x49 &&
        pcmBytes[2] === 0x46 &&
        pcmBytes[3] === 0x46
    ) {
        pcmBytes = pcmBytes.subarray(44);
    }

    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;

    const silenceSamples = Math.floor(sampleRate * 0.40);
    const silenceBytesLength = silenceSamples * blockAlign;
    const totalDataSize = pcmBytes.byteLength + silenceBytesLength;

    const wavBuffer = new ArrayBuffer(44 + totalDataSize);
    const view = new DataView(wavBuffer);

    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + totalDataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, totalDataSize, true);

    const targetArray = new Uint8Array(wavBuffer, 44);
    targetArray.set(pcmBytes, 0);

    return Buffer.from(wavBuffer);
}

async function callSingleCartesiaTTS(apiKey, voiceId, text) {
    const models = ["sonic-latest", "sonic-3", "sonic"];
    let lastStatus = 0;
    let lastError = "";

    for (const modelId of models) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const res = await fetch("https://api.cartesia.ai/tts/bytes", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Cartesia-Version": "2024-11-13",
                    "X-API-Key": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model_id: modelId,
                    transcript: text,
                    voice: { mode: "id", id: voiceId },
                    language: "hi",
                    output_format: {
                        container: "raw",
                        encoding: "pcm_s16le",
                        sample_rate: 24000
                    }
                })
            });
            clearTimeout(timer);

            if (res.ok) {
                const rawBuf = await res.arrayBuffer();
                if (rawBuf && rawBuf.byteLength > 200) {
                    const wavBuf = buildWavBufferFromPcm(rawBuf, 24000);
                    return {
                        ok: true,
                        audioBase64: wavBuf.toString("base64"),
                        modelUsed: modelId
                    };
                }
            }

            lastStatus = res.status;
            const errTxt = await res.text();
            lastError = errTxt.slice(0, 140);

            if (res.status === 401 || res.status === 402 || res.status === 404 || res.status === 429) {
                break;
            }
        } catch (err) {
            clearTimeout(timer);
            lastStatus = 500;
            lastError = err.message;
            break;
        }
    }

    return { ok: false, status: lastStatus, error: lastError };
}

async function tryKeyAcrossAllVoices(entry, text) {
    const lockedVoice = keyVoiceLockCache.get(entry.key);
    const voicesToTest = lockedVoice
        ? [lockedVoice, ...entry.candidateVoices.filter((v) => v.id !== lockedVoice.id)]
        : entry.candidateVoices;

    let lastRes = { ok: false, status: 0, error: "No voices tested" };

    for (const vObj of voicesToTest) {
        const res = await callSingleCartesiaTTS(entry.key, vObj.id, text);
        if (res.ok) {
            keyVoiceLockCache.set(entry.key, vObj);
            return {
                ok: true,
                audioBase64: res.audioBase64,
                modelUsed: res.modelUsed,
                voiceNum: vObj.num
            };
        }

        lastRes = { ...res, voiceNum: vObj.num };

        if (res.status === 404) {
            continue;
        }
        if (res.status === 401 || res.status === 402 || res.status === 429) {
            break;
        }
    }

    return lastRes;
}

function formatHistoryAndMemoryContext(chatHistory, longTermMemory) {
    let contextBlock = "";

    const istDateStr = new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "full",
        timeStyle: "short"
    });
    contextBlock += `CURRENT REAL-TIME DATE & TIME (IST): ${istDateStr}\n`;

    if (Array.isArray(longTermMemory) && longTermMemory.length > 0) {
        contextBlock +=
            "PERMANENT LONG-TERM FAMILY MEMORIES (Always remember these facts about the family):\n" +
            longTermMemory.map((fact, idx) => ` - ${idx + 1}. ${fact}`).join("\n") +
            "\n\n";
    }

    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
        const recent = chatHistory.slice(-6);
        const lines = recent.map((turn) => {
            const speaker = turn.role === "papa" ? "Papa" : "Family Member";
            return `${speaker}: "${turn.text}"`;
        });
        contextBlock += "RECENT LIVE CALL CONVERSATION HISTORY:\n" + lines.join("\n") + "\n\n";
    }

    return contextBlock;
}

async function generateFreeBackupReply(
    userText,
    currentFacingMode,
    savedFaces,
    chatHistory,
    longTermMemory,
    singingMode,
    logger
) {
    let familyHint = "";
    if (currentFacingMode === "user" && Array.isArray(savedFaces) && savedFaces.length > 0) {
        const names = savedFaces.map((f) => f.name).join(", ");
        familyHint = `\nRegistered family members in household: ${names}.`;
    }

    const singingInstruction = singingMode
        ? "\n(IMPORTANT: The family member wants you to SING! Write 4-6 melodic Hindi lines of the requested song/bhajan/lori with musical stretches like आऽऽ..., होऽऽ..., and commas/ellipses '...'.)"
        : "\n(Reply warmly as Papa AGI in 2-3 complete Devanagari Hindi sentences ending with पूर्ण विराम ।)";

    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);
    const promptBody = contextText + `Family member now said: "${userText}"` + singingInstruction;

    if (process.env.GROQ_API_KEY) {
        try {
            logger.push("W", "SERVER", "Falling back to Groq Llama-3.3...");
            const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                        { role: "user", content: promptBody }
                    ],
                    max_tokens: 450,
                    temperature: 0.7
                })
            });
            const groqData = await groqRes.json();
            const text = groqData?.choices?.[0]?.message?.content;
            if (groqRes.ok && text) {
                logger.push("I", "SERVER", "Groq Llama-3.3 backup succeeded.");
                return {
                    aiText: ensureCompleteHindiSentence(text),
                    geminiKeyUsed: "Backup",
                    modelUsed: "Groq-Llama-3.3"
                };
            }
            logger.push("W", "SERVER", `Groq backup returned HTTP ${groqRes.status}`);
        } catch (err) {
            logger.push("E", "SERVER", `Groq backup failed: ${err.message}`);
        }
    }

    // Text-only Pollinations request (avoids 31KB image_url rejections on Free endpoint!)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8500);
    try {
        logger.push("W", "SERVER", "Falling back to Pollinations Free Text AI...");
        const freeRes = await fetch("https://text.pollinations.ai/openai", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "openai",
                messages: [
                    { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                    { role: "user", content: promptBody }
                ]
            })
        });
        clearTimeout(timer);

        if (freeRes.ok) {
            const freeData = await freeRes.json();
            const reply = freeData?.choices?.[0]?.message?.content;
            if (reply && reply.trim()) {
                logger.push("I", "SERVER", "Pollinations Free AI fallback succeeded.");
                return {
                    aiText: ensureCompleteHindiSentence(reply),
                    geminiKeyUsed: "Auto-Backup",
                    modelUsed: "Free-AGI-Fallback"
                };
            }
        } else {
            logger.push("W", "SERVER", `Pollinations returned HTTP ${freeRes.status}`);
        }
    } catch (err) {
        clearTimeout(timer);
        logger.push("E", "SERVER", `Pollinations fallback error: ${err.message}`);
    }

    return null;
}

async function generateGeminiReplyInternal(body, logger) {
    const geminiKeys = getGeminiKeysFromEnv();
    const userText = sanitizeRepeatedUserSpeech(body.userText || "नमस्ते पापा");
    const base64Frame = body.base64Frame || null;
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
    const longTermMemory = Array.isArray(body.longTermMemory) ? body.longTermMemory : [];

    const singingMode = isSingingRequest(userText);
    const { agiAction, newMemoryFact } = detectAgiActionAndMemory(userText);
    const useWebSearch = needsLiveWebSearch(userText);

    logger.push(
        "I",
        "SERVER",
        `Gemini stage start | keys=${geminiKeys.length}, vision=${Boolean(base64Frame)}, webSearch=${useWebSearch}, singing=${singingMode}`
    );

    const userParts = [];
    if (base64Frame && currentFacingMode === "user" && savedFaces.length > 0) {
        userParts.push({ text: "REGISTERED FAMILY MEMBERS REFERENCE PHOTOS:" });
        for (const member of savedFaces) {
            if (member && member.name && member.photo) {
                userParts.push({ text: `Family Member Name & Relation with Papa: ${member.name}` });
                userParts.push({
                    inline_data: { mime_type: "image/jpeg", data: member.photo }
                });
            }
        }
    }

    if (base64Frame) {
        userParts.push({
            text: `CURRENT LIVE CAMERA VIEW (${currentFacingMode === "user" ? "Front Camera - Person talking to Papa" : "Back Camera - Object/Document/Scene shown to Papa"}):`
        });
        userParts.push({
            inline_data: { mime_type: "image/jpeg", data: base64Frame }
        });
    }

    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);
    const modePromptSuffix = singingMode
        ? `\n(🎵 SINGING MODE ACTIVE: आपका बच्चा आपसे गाना/भजन/लोरी सुनना चाहता है! मना बिल्कुल मत करें। प्यार से एक छोटी लाइन बोलकर तुरंत 4 से 6 लाइनों का सुरीला हिंदी गीत/भजन देवनागरी में गाकर सुनाएँ। गाने के शब्दों में सुर खींचने के लिए 'आऽऽ...', 'होऽऽ...', और '...' का प्रयोग करें।)`
        : `\n(अपना जवाब हमेशा 2 से 3 पूरे और स्पष्ट देवनागरी हिंदी वाक्यों में पूरा लिखें, वाक्य बीच में कभी अधूरा न छोड़ें।)`;

    userParts.push({
        text: contextText + `Family member now said: "${userText}"` + modePromptSuffix
    });

    let lastError =
        geminiKeys.length > 0
            ? "All Gemini keys/models temporarily busy or quota reached"
            : "No Gemini keys configured";

    if (geminiKeys.length > 0) {
        if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;

        const modelsToTry = await getAutoUpdatedGeminiModelsList(geminiKeys[geminiKeyIdx], logger);

        // Pass 0: Respect circuit-breaker cache; Pass 1: Emergency Bypass if Pass 0 skipped every single key/model!
        let attemptedAnyCall = false;

        for (let pass = 0; pass < 2; pass++) {
            if (pass === 1) {
                if (attemptedAnyCall) break; // Pass 0 already made live attempts
                logger.push("W", "SERVER", "All models were in cooldown cache -> Running Emergency Fresh Bypass!");
                exhaustedModelCache.clear();
            }

            const modelsForThisPass = pass === 0 ? modelsToTry : modelsToTry.slice(0, 3);

            for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
                const activeKey = geminiKeys[geminiKeyIdx];
                const keyNum = geminiKeyIdx + 1;

                for (const modelName of modelsForThisPass) {
                    const cacheKey = `${activeKey.slice(-6)}:${modelName}`;
                    const exhaustedUntil = exhaustedModelCache.get(cacheKey) || 0;
                    if (pass === 0 && Date.now() < exhaustedUntil) {
                        continue;
                    }

                    attemptedAnyCall = true;
                    const toolModes = useWebSearch ? [true, false] : [false];

                    for (const withSearchTool of toolModes) {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), 7500);
                        try {
                            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
                            const payload = {
                                contents: [{ role: "user", parts: userParts }],
                                systemInstruction: { parts: [{ text: FATHER_AGI_PROMPT }] },
                                generationConfig: {
                                    maxOutputTokens: 1024,
                                    temperature: singingMode ? 0.78 : 0.65
                                }
                            };
                            if (withSearchTool) {
                                payload.tools = [{ google_search: {} }];
                            }

                            const gRes = await fetch(url, {
                                method: "POST",
                                signal: controller.signal,
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(payload)
                            });
                            clearTimeout(timer);

                            const data = await gRes.json();
                            const candidate = data?.candidates?.[0];
                            const finishReason = candidate?.finishReason || "UNKNOWN";
                            const partsList = candidate?.content?.parts || [];
                            const combinedText = partsList
                                .filter((p) => !p.thought && typeof p.text === "string")
                                .map((p) => p.text)
                                .join(" ")
                                .trim();

                            if (gRes.ok && combinedText) {
                                const finalReply = ensureCompleteHindiSentence(combinedText);
                                const finalEmotion = singingMode ? "singing" : detectPapaEmotion(userText, finalReply);
                                logger.push(
                                    "I",
                                    "SERVER",
                                    `Gemini OK via G-Key#${keyNum} (${modelName}${withSearchTool ? "+WebSearch" : ""}) | finish=${finishReason} | emotion=${finalEmotion}`
                                );
                                return {
                                    aiText: finalReply,
                                    emotion: finalEmotion,
                                    geminiKeyUsed: keyNum,
                                    modelUsed: withSearchTool ? `${modelName}+WebSearch` : modelName,
                                    agiAction,
                                    newMemoryFact
                                };
                            }

                            // CRITICAL FIX: Fault-isolate WebSearch tool failures!
                            // If google_search returned ANY error (400/403/429/503), DO NOT blacklist the model —
                            // immediately retry standard generateContent on the SAME model!
                            if (withSearchTool) {
                                logger.push(
                                    "W",
                                    "SERVER",
                                    `${modelName} WebSearch failed (HTTP ${gRes.status}); retrying standard mode immediately.`
                                );
                                continue;
                            }

                            lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;
                            logger.push("W", "SERVER", `Skip G-Key#${keyNum} ${modelName} -> HTTP ${gRes.status}`);

                            if (gRes.status === 404) {
                                exhaustedModelCache.set(cacheKey, Date.now() + 6 * 60 * 60 * 1000);
                                break;
                            }
                            if (gRes.status === 429) {
                                // Short 90s cooldown so RPM limits recover automatically without locking out keys!
                                exhaustedModelCache.set(cacheKey, Date.now() + 90 * 1000);
                                break;
                            }
                            if (gRes.status === 503 || gRes.status === 500 || gRes.status === 400) {
                                exhaustedModelCache.set(cacheKey, Date.now() + 45 * 1000);
                                break;
                            }
                            if (gRes.status === 401 || gRes.status === 403) {
                                break;
                            }
                        } catch (err) {
                            clearTimeout(timer);
                            if (withSearchTool) {
                                logger.push("W", "SERVER", `${modelName} WebSearch timed out; retrying standard mode.`);
                                continue;
                            }
                            lastError = err.message;
                            exhaustedModelCache.set(cacheKey, Date.now() + 45 * 1000);
                            logger.push("E", "SERVER", `Timeout/Fail G-Key#${keyNum} ${modelName}: ${err.message} (45s cooldown)`);
                            break;
                        }
                    }
                }

                const shifted = shiftPingPongIndex(geminiKeyIdx, geminiKeyDir, geminiKeys.length);
                geminiKeyIdx = shifted.idx;
                geminiKeyDir = shifted.dir;
            }
        }
    }

    const backupReply = await generateFreeBackupReply(
        userText,
        currentFacingMode,
        savedFaces,
        chatHistory,
        longTermMemory,
        singingMode,
        logger
    );
    if (backupReply) {
        backupReply.emotion = singingMode ? "singing" : detectPapaEmotion(userText, backupReply.aiText);
        backupReply.agiAction = agiAction;
        backupReply.newMemoryFact = newMemoryFact;
        return backupReply;
    }

    throw new Error(`Gemini API Error (${geminiKeys.length} keys tried): ${lastError}`);
}

async function generateTtsAudioInternal(rawText, logger) {
    const cleanedForVoice = String(rawText || "").replace(/[🎵🎶🎼🎤✨]/g, "");
    const text = ensureCompleteHindiSentence(cleanedForVoice);
    const { pool: cartesiaPool } = getCartesiaPoolFromEnv();
    const renderUrl = (process.env.RENDER_TTS_URL || "https://papa-voice-cloud.onrender.com/api/tts").trim();
    let lastCartesiaError = "No Cartesia keys configured";

    if (cartesiaPool.length > 0) {
        if (cartesiaKeyIdx >= cartesiaPool.length) cartesiaKeyIdx = 0;

        for (let attempt = 0; attempt < cartesiaPool.length; attempt++) {
            const entry = cartesiaPool[cartesiaKeyIdx];
            const keyNum = cartesiaKeyIdx + 1;

            const keyCooldownUntil = exhaustedCartesiaCache.get(entry.key) || 0;
            if (Date.now() < keyCooldownUntil) {
                const shifted = shiftPingPongIndex(cartesiaKeyIdx, cartesiaKeyDir, cartesiaPool.length);
                cartesiaKeyIdx = shifted.idx;
                cartesiaKeyDir = shifted.dir;
                continue;
            }

            const result = await tryKeyAcrossAllVoices(entry, text);
            if (result.ok) {
                logger.push(
                    "I",
                    "SERVER",
                    `TTS OK via Cartesia Key#${keyNum}/${cartesiaPool.length} (V#${result.voiceNum}, ${result.modelUsed})`
                );
                return {
                    audioBase64: result.audioBase64,
                    engineLabel: `Cartesia Key #${keyNum}/${cartesiaPool.length} (Voice #${result.voiceNum} - ${result.modelUsed})`
                };
            }

            lastCartesiaError = `Key #${keyNum} V#${result.voiceNum || 1} [${result.status}]: ${result.error}`;
            logger.push("W", "SERVER", `Skip Cartesia ${lastCartesiaError}`);

            if (result.status === 402 || result.status === 401) {
                exhaustedCartesiaCache.set(entry.key, Date.now() + 6 * 60 * 60 * 1000);
            } else if (result.status === 429) {
                exhaustedCartesiaCache.set(entry.key, Date.now() + 10 * 60 * 1000);
            }

            const shifted = shiftPingPongIndex(cartesiaKeyIdx, cartesiaKeyDir, cartesiaPool.length);
            cartesiaKeyIdx = shifted.idx;
            cartesiaKeyDir = shifted.dir;
        }
    }

    logger.push("W", "SERVER", "All Cartesia keys skipped/failed; falling back to Render Piper TTS...");
    const rRes = await fetch(renderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, length_scale: 1.12 })
    });

    if (rRes.ok) {
        const rawWav = await rRes.arrayBuffer();
        const cleanWav = buildWavBufferFromPcm(rawWav, 22050);
        logger.push("I", "SERVER", "Render Cloud Piper TTS fallback succeeded.");
        return {
            audioBase64: cleanWav.toString("base64"),
            engineLabel: "Render Cloud Piper TTS"
        };
    }

    throw new Error(`Cartesia (${lastCartesiaError}) & Render (${rRes.status}) both failed.`);
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const startTimeMs = Date.now();
    const body = req.body || {};
    const action = body.action || "";
    const reqId = body.reqId || `SRV-${startTimeMs.toString().slice(-4)}`;
    const logger = createServerLogger(reqId);
    const requiredPin = (process.env.APP_PIN || "1234").trim();

    if (action === "verify_pin") {
        const enteredPin = String(body.pin || "").trim();
        if (enteredPin === requiredPin) {
            const gKeys = getGeminiKeysFromEnv();
            const discovered =
                gKeys.length > 0 ? await getAutoUpdatedGeminiModelsList(gKeys[0], logger) : NOV_2026_ACTIVE_MODELS;
            logger.push("I", "SERVER", `PIN verified OK (${Date.now() - startTimeMs}ms)`);
            return res.status(200).json({
                ok: true,
                releaseBaseUrl: getNormalizedReleaseBaseUrl(),
                autoDiscoveredModels: discovered.slice(0, 5),
                serverLogs: logger.logs
            });
        }
        logger.push("E", "SERVER", "PIN verification failed (401)");
        return res.status(401).json({ ok: false, error: "Wrong PIN", serverLogs: logger.logs });
    }

    if (String(body.pin || "").trim() !== requiredPin) {
        return res.status(401).json({ error: "Unauthorized PIN", serverLogs: logger.logs });
    }

    if (action === "chat_and_tts") {
        try {
            const t0 = Date.now();
            const chatResult = await generateGeminiReplyInternal(body, logger);
            const geminiMs = Date.now() - t0;

            const t1 = Date.now();
            const ttsResult = await generateTtsAudioInternal(chatResult.aiText, logger);
            const ttsMs = Date.now() - t1;

            const totalMs = Date.now() - startTimeMs;
            logger.push("I", "SERVER", `Pipeline complete in ${totalMs}ms (AI=${geminiMs}ms, TTS=${ttsMs}ms)`);

            return res.status(200).json({
                aiText: chatResult.aiText,
                emotion: chatResult.emotion || "talking",
                geminiKeyUsed: chatResult.geminiKeyUsed,
                modelUsed: chatResult.modelUsed,
                agiAction: chatResult.agiAction || null,
                newMemoryFact: chatResult.newMemoryFact || null,
                audioBase64: ttsResult.audioBase64,
                engineLabel: `G-Key #${chatResult.geminiKeyUsed} (${chatResult.modelUsed}) | ${ttsResult.engineLabel}`,
                telemetry: { totalMs, geminiMs, ttsMs },
                serverLogs: logger.logs
            });
        } catch (err) {
            logger.push("E", "SERVER", `chat_and_tts fatal error: ${err.message}`);
            return res.status(500).json({ error: err.message, serverLogs: logger.logs });
        }
    }

    if (action === "chat") {
        try {
            const chatResult = await generateGeminiReplyInternal(body, logger);
            return res.status(200).json({ ...chatResult, serverLogs: logger.logs });
        } catch (err) {
            logger.push("E", "SERVER", `chat error: ${err.message}`);
            return res.status(500).json({ error: err.message, serverLogs: logger.logs });
        }
    }

    if (action === "tts") {
        const text = (body.text || "").trim();
        if (!text) {
            return res.status(400).json({ error: "Empty text for TTS", serverLogs: logger.logs });
        }
        try {
            const ttsResult = await generateTtsAudioInternal(text, logger);
            return res.status(200).json({
                ...ttsResult,
                emotion: body.forceEmotion || detectPapaEmotion("", text),
                serverLogs: logger.logs
            });
        } catch (err) {
            logger.push("E", "SERVER", `tts error: ${err.message}`);
            return res.status(502).json({ error: err.message, serverLogs: logger.logs });
        }
    }

    if (action === "diag") {
        // Clear cooldown caches when user manually runs Check Keys
        exhaustedModelCache.clear();
        const geminiKeys = getGeminiKeysFromEnv();
        const { pool: cartesiaPool, allVoices } = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        const liveModels =
            geminiKeys.length > 0
                ? await getAutoUpdatedGeminiModelsList(geminiKeys[0], logger)
                : NOV_2026_ACTIVE_MODELS;

        logs.push(`🔄 AUTO-DISCOVERED FAST GEMINI MODELS: ${liveModels.slice(0, 5).join(", ")}`);
        logs.push(`🧠 GEMINI KEYS FOUND: ${geminiKeys.length}`);

        for (let g = 0; g < geminiKeys.length; g++) {
            const gKey = geminiKeys[g];
            const masked = gKey.slice(0, 6) + "..." + gKey.slice(-4);
            let keyWorked = false;
            let lastGStatus = "";

            for (const testModel of liveModels.slice(0, 4)) {
                try {
                    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${gKey}`;
                    const gRes = await fetch(gUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ role: "user", parts: [{ text: "नमस्ते" }] }],
                            generationConfig: { maxOutputTokens: 20 }
                        })
                    });
                    if (gRes.ok) {
                        logs.push(`✅ Gemini Key #${g + 1} (${masked}): ACTIVE on ${testModel}!`);
                        geminiKeyIdx = g;
                        keyWorked = true;
                        break;
                    } else {
                        lastGStatus = `HTTP ${gRes.status} on ${testModel}`;
                    }
                } catch (e) {
                    lastGStatus = e.message;
                }
            }
            if (!keyWorked) {
                logs.push(`⚠️ Gemini Key #${g + 1} (${masked}): Quota Full (${lastGStatus}) -> Auto-Backup AI Ready`);
            }
        }

        logs.push(`\n🎙️ CARTESIA VOICES FOUND: ${allVoices.length} | KEYS FOUND: ${cartesiaPool.length}`);
        for (let k = 0; k < cartesiaPool.length; k++) {
            const entry = cartesiaPool[k];
            const maskedKey = entry.key.slice(0, 9) + "..." + entry.key.slice(-4);
            const resTest = await tryKeyAcrossAllVoices(
                entry,
                "नमस्ते बेटा, सदा खुश रहो, मेरा आशीर्वाद हमेशा तुम्हारे साथ है।"
            );
            if (resTest.ok) {
                exhaustedCartesiaCache.delete(entry.key);
                logs.push(`✅ Key #${k + 1} (${maskedKey}) ➔ Matched Voice #${resTest.voiceNum} (${resTest.modelUsed}): SUCCESS!`);
                if (!firstSuccessAudio) {
                    firstSuccessAudio = resTest.audioBase64;
                    cartesiaKeyIdx = k;
                    activeKeyLabel = `Gemini (${geminiKeys.length} Keys) + Cartesia Key #${k + 1}/${cartesiaPool.length} (Voice #${resTest.voiceNum})`;
                }
            } else {
                if (resTest.status === 402 || resTest.status === 401) {
                    exhaustedCartesiaCache.set(entry.key, Date.now() + 6 * 60 * 60 * 1000);
                }
                logs.push(`❌ Key #${k + 1} (${maskedKey}): HTTP ${resTest.status} - ${resTest.error}`);
            }
        }

        logger.push("I", "SERVER", `Diagnostics completed (${Date.now() - startTimeMs}ms)`);
        return res.status(200).json({
            logs,
            foundWorking: Boolean(firstSuccessAudio),
            activeKeyLabel,
            audioBase64: firstSuccessAudio,
            serverLogs: logger.logs
        });
    }

    return res.status(400).json({ error: "Invalid action", serverLogs: logger.logs });
}
