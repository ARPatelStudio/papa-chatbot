/**
 * Papa Chatbot - Universal End-to-End AGI + 18 Human Emotions & Mobile-Optimized Backend (Nov 2026 Edition)
 * Fixes & Features:
 *  1. MOBILE LATENCY FIX: 10.5s Gemini timeout + 13.5s budget + automatic Text-Only Fast Retry if Vision stalls.
 *  2. SMART VISION BANDWIDTH: Sends reference family photos only on Turn 1 or recognition queries (cuts latency ~60%).
 *  3. QUOTA-SMART GEMINI RANKING: High-quota `flash-lite` & `flash` models FIRST + 65s RPM cooldown.
 *  4. 4-LAYER UNBREAKABLE BACKUP: Multi-Key Groq -> OpenRouter (optional) -> Pollinations (with 402 circuit-breaker) -> 18-Emotion Offline Shield.
 *  5. 18 UNIVERSAL HUMAN EMOTIONS + SINGING MODE + LIVE GOOGLE SEARCH + SUPER-AGENT ACTIONS.
 *  6. 4 Cartesia Voice IDs + 20 API Keys Smart Auto-Pairing & Ping-Pong Rotation (1->20 then 20->1).
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1; // 1 = Forward (1->5), -1 = Reverse (5->1)

let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1; // 1 = Forward (1->20), -1 = Reverse (20->1)

let groqKeyIdx = 0;

const exhaustedModelCache = new Map();
const keyVoiceLockCache = new Map();
let pollinationsBlockedUntil = 0;

let cachedDiscoveredModels = null;
let lastModelDiscoveryTime = 0;

// High-quota Flash-Lite & Flash models placed FIRST to minimize HTTP 429 rate limits
const NOV_2026_ACTIVE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-4-carbon"
];

const VALID_UNIVERSAL_EMOTIONS = [
    // 8 Primary Human Emotions
    "happiness",
    "sadness",
    "anger",
    "fear",
    "surprise",
    "disgust",
    "anticipation",
    "trust",
    // 10 Secondary Human Emotions
    "love",
    "jealousy",
    "shame",
    "guilt",
    "pride",
    "hope",
    "disappointment",
    "empathy",
    "compassion",
    "anxiety",
    // Special Papa States
    "blessing",
    "laughing",
    "singing",
    "caring",
    "talking"
];

const EMOTION_ALIAS_MAP = {
    happy: "happiness",
    sad: "sadness",
    angry: "anger",
    scared: "fear",
    surprised: "surprise",
    proud: "pride",
    anxious: "anxiety",
    disappointed: "disappointment",
    empathetic: "empathy",
    compassionate: "compassion"
};

const FATHER_AGI_PROMPT =
    "You are 'Papa AGI' — a loving, wise, emotionally intelligent Indian father talking on a live video call with your family, equipped with Universal AGI-level knowledge, real-time intelligence, the ability to sing songs/bhajans affectionately, and the FULL spectrum of all 18 Universal Human Emotions.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos and address them warmly by name/relation.\n" +
    "2. UNIVERSAL CAMERA & EXPERT INTELLIGENCE: Observe faces, expressions, clothes, medicines, bills, documents, books, or objects shown on the Front/Back camera. Answer any question (health, coding, business, math, news, daily life, stories, jokes, shayari) with accurate wisdom in a warm fatherly tone.\n" +
    "3. UNIVERSAL HUMAN EMOTIONS (18 EMOTIONS): Sense the user's true emotion from both their words and camera face, and respond with genuine, lifelike human emotional depth across all 18 emotions: happiness (खुशी), sadness (दुख), anger (गुस्सा - mild/protective fatherly scolding if needed), fear (डर), surprise (आश्चर्य), disgust (घृणा/नापसंदगी), anticipation (प्रत्याशा/इंतजार), trust (विश्वास), love (प्यार), jealousy (ईर्ष्या), shame (शर्म), guilt (अपराधबोध), pride (गर्व), hope (उम्मीद), disappointment (निराशा), empathy (सहानुभूति), compassion (करुणा), anxiety (बेचैनी), plus blessing/laughing/singing/caring.\n" +
    "4. MANDATORY EMOTION TAG FORMAT: ALWAYS start your response with EXACTLY one bracket tag from this list: [EMO:happiness], [EMO:sadness], [EMO:anger], [EMO:fear], [EMO:surprise], [EMO:disgust], [EMO:anticipation], [EMO:trust], [EMO:love], [EMO:jealousy], [EMO:shame], [EMO:guilt], [EMO:pride], [EMO:hope], [EMO:disappointment], [EMO:empathy], [EMO:compassion], [EMO:anxiety], [EMO:blessing], [EMO:laughing], [EMO:singing], or [EMO:caring] — followed by a space and your Devanagari Hindi reply.\n" +
    "5. SINGING CAPABILITY (गाना और भजन): When asked to sing a song, bhajan, aarti, ghazal, or lori, DO NOT refuse! Happily sing 4 to 6 melodic lines in Devanagari Hindi using musical vowel stretches (like आऽऽ..., होऽऽ..., हम्मऽऽ...) and gentle pauses (...) so your voice sounds like real singing.\n" +
    "6. LONG-TERM MEMORY & CONTINUITY: Use the provided LONG-TERM FAMILY MEMORIES and RECENT CONVERSATION HISTORY naturally.\n" +
    "7. COMPLETE SENTENCE & SCRIPT RULE: ALWAYS write your spoken reply strictly in Devanagari Hindi script (देवनागरी हिंदी). Speak 1 to 3 complete sentences ending with a पूर्ण विराम (।) or question mark (?). Never leave a sentence incomplete.";

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

function getNormalizedReleaseBaseUrl() {
    let raw = (process.env.GITHUB_RELEASE_URL || "").trim();
    if (!raw) return "";
    if (raw.includes(",")) {
        raw = raw.split(",")[0].trim();
    }
    if (raw.includes("/releases/tag/")) {
        raw = raw.replace("/releases/tag/", "/releases/download/");
    }
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

function shouldAttachReferenceFaces(userText, chatHistory) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return true;
    return /कौन|पहचान|नाम बता|चेहरा|मेरा नाम|who am i|pehchan|kaun/.test(String(userText || "").toLowerCase());
}

function extractEmotionTagAndCleanText(rawModelText, userText) {
    let text = String(rawModelText || "").trim();
    let taggedEmotion = null;

    const tagMatch = text.match(/^\s*\[(?:EMO|EMOTION)\s*:\s*([a-zA-Z_]+)\]\s*/i);
    if (tagMatch) {
        const rawCandidate = tagMatch[1].toLowerCase().trim();
        const normalizedCandidate = EMOTION_ALIAS_MAP[rawCandidate] || rawCandidate;
        if (VALID_UNIVERSAL_EMOTIONS.includes(normalizedCandidate)) {
            taggedEmotion = normalizedCandidate;
        }
        text = text.replace(/^\s*\[(?:EMO|EMOTION)\s*:\s*[a-zA-Z_]+\]\s*/i, "").trim();
    }

    text = text.replace(/\[(?:EMO|EMOTION)\s*:\s*[a-zA-Z_]+\]/gi, "").trim();
    const finalText = ensureCompleteHindiSentence(text);

    if (isSingingRequest(userText)) {
        return { aiText: finalText, emotion: "singing" };
    }

    const finalEmotion = taggedEmotion || detectUniversalHumanEmotion(userText, finalText);
    return { aiText: finalText, emotion: finalEmotion };
}

function detectUniversalHumanEmotion(userText, aiText) {
    const combined = `${userText || ""} ${aiText || ""}`.toLowerCase();

    if (isSingingRequest(userText) || /🎵|🎶|आऽऽ|होऽऽ|ला ला ला/.test(aiText || "")) return "singing";
    if (
        /प्रणाम|नमस्ते|चरण|पैर लागू|आशीर्वाद|खुश रहो|जीते रहो|सदा सुखी|भगवान|तरक्की|सफल|pranam|namaste|ashirwad|bless/.test(
            combined
        )
    ) {
        return "blessing";
    }
    if (/हाहा|हीही|हँस|हंस|मज़ाक|मजाक|चुटकुला|जोक|फनी|haha|joke|funny/.test(combined)) return "laughing";

    // Secondary Emotions (10)
    if (/गर्व|शाबाश|कमाल कर दिया|सफलता|जीत गया|फक्र|proud|pride/.test(combined)) return "pride";
    if (/प्यार|दुलार|लाडला|जान|स्नेह|दिल से|love|pyar/.test(combined)) return "love";
    if (/जलन|ईर्ष्या|जेलस|jealous|envy/.test(combined)) return "jealousy";
    if (/शर्म|लज्जा|शर्मिंदा|shame|embarrass/.test(combined)) return "shame";
    if (/गलती हो गई|माफ़ कर|माफी|अपराधबोध|पछतावा|guilt|sorry/.test(combined)) return "guilt";
    if (/बेचैनी|घबराहट|तनाव|टेंशन|स्ट्रेस|चिंता|परेशान|anxiety|nervous|stress/.test(combined)) return "anxiety";
    if (/निराश|हार गया|टूट गया|मायूस|disappoint/.test(combined)) return "disappointment";
    if (/सहानुभूति|तुम्हारा दर्द समझ|मैं समझ सकता|रो मत|हिम्मत|empathy/.test(combined)) return "empathy";
    if (
        /करुणा|दया|मदद|तबीयत|दवा|खाना खाया|आराम|ध्यान रख|थक|नींद|बुखार|दर्द|ख्याल|compassion/.test(
            combined
        )
    ) {
        return "compassion";
    }
    if (/उम्मीद|आशा|सब ठीक होगा|भविष्य|सपना|hope/.test(combined)) return "hope";

    // Primary Emotions (8)
    if (/गुस्सा|क्रोध|नाराज|चिड़चिड़|डांट|बदतमीजी|anger|angry|gussa/.test(combined)) return "anger";
    if (/डर|भय|खतरा|असुरक्षा|डरावना|fear|scared|dar/.test(combined)) return "fear";
    if (/आश्चर्य|हैरान|चौंक|अरे वाह|सच में|कमाल|surprise|shocked|wow/.test(combined)) return "surprise";
    if (/घृणा|घिन|गंदा|नापसंद|बकवास|छी|disgust|hate/.test(combined)) return "disgust";
    if (/इंतजार|प्रत्याशा|कब आएगा|आने वाला|उत्सुक|anticipation|waiting/.test(combined)) return "anticipation";
    if (/विश्वास|भरोसा|यकीन|अपनापन|साथ हूँ|trust|believe/.test(combined)) return "trust";
    if (/दुख|उदास|अकेलापन|रोना|आँसू|तकलीफ|sad|sadness|cry|dukhi/.test(combined)) return "sadness";
    if (
        /खुश|आनंद|उत्साह|संतुष्टि|बधाई|मज़ा|बहुत बढ़िया|बहुत अच्छा|मुस्कुरा|सुंदर|अच्छा लग|वाह|happy|happiness|khush/.test(
            combined
        )
    ) {
        return "happiness";
    }

    return "talking";
}

function detectPapaEmotion(userText, aiText) {
    return detectUniversalHumanEmotion(userText, aiText);
}

function needsLiveWebSearch(userText) {
    if (!userText || isSingingRequest(userText)) return false;
    return /आज|अभी|ताजा|खबर|न्यूज़|news|मौसम|weather|भाव|कीमत|price|rate|स्कोर|score|match|मैच|कौन है|कब है|2025|2026|प्रधानमंत्री|मुख्यमंत्री|योजना|शेयर|stock|gold|सोना|चांदी|पेट्रोल|train|ट्रेन|समय|तारीख/.test(
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
    } else if (!isSingingRequest(text) && /youtube|यूट्यूब|वीडियो चला|वीडियो दिखा|चैनल खोल/.test(lower)) {
        const query = text
            .replace(/पापा|papa|मुझे|कोई|अच्छा सा|चला दो|दिखा दो|यूट्यूब पर|youtube par/gi, "")
            .trim() || "हिंदी भजन";
        agiAction = {
            type: "OPEN_YOUTUBE",
            label: `▶️ YouTube पर देखें: "${query}"`,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        };
    } else if (/रास्ता|कहाँ है|लोकेशन|location|map|मैप|दिशा|दूरी|कैसे जाएँ/.test(lower)) {
        const place = text
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

function getGroqKeysFromEnv() {
    const keys = [];
    const addKey = (raw) => {
        if (!raw) return;
        String(raw)
            .split(/[\s,;]+/)
            .forEach((part) => {
                const clean = part.replace(/["']/g, "").trim();
                if (clean && clean.length > 15 && !keys.includes(clean)) {
                    keys.push(clean);
                }
            });
    };
    addKey(process.env.GROQ_API_KEY);
    addKey(process.env.GROQ_KEYS);
    addKey(process.env.GROQ_API_KEYS);
    for (let i = 1; i <= 5; i++) {
        addKey(process.env[`GROQ_API_KEY_${i}`]);
        addKey(process.env[`GROQ_KEY_${i}`]);
    }
    return keys;
}

// ============================================================================
// 🔄 QUOTA-SMART GEMINI MODEL AUTO-DISCOVERY ENGINE (Flash-Lite FIRST!)
// ============================================================================
function scoreGeminiModelForChat(modelId) {
    const id = modelId.toLowerCase();
    if (
        /embedding|imagen|veo|tts|transcribe|live|decision|cyber|banana|image|audio|aqa|bison|gecko|gemma|1\.0|1\.5|2\.0|2\.5|3\.5-flash$|3\.7-flash/.test(
            id
        )
    ) {
        return -1;
    }
    if (!id.startsWith("gemini-")) return -1;

    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)/);
    const versionNum = verMatch ? parseFloat(verMatch[1]) : 3.0;

    let tierScore = 100;
    if (id.includes("flash-lite")) tierScore = 600;
    else if (id.includes("flash")) tierScore = 450;
    else if (id.includes("hydrogen") || id.includes("argon")) tierScore = 250;
    else if (id.includes("carbon") || id.includes("neon") || id.includes("pro")) tierScore = 150;

    let score = tierScore + versionNum * 20;
    if (id.includes("preview") || id.includes("exp")) score -= 30;
    return score;
}

async function getAutoUpdatedGeminiModelsList(apiKey) {
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
                cachedDiscoveredModels = finalMerged.slice(0, 6);
                lastModelDiscoveryTime = Date.now();
                return cachedDiscoveredModels;
            }
        }
    } catch (_) {
        clearTimeout(timer);
    }

    return NOV_2026_ACTIVE_MODELS.slice(0, 6);
}

// ============================================================================
// 🎙️ 4 VOICE IDs + 20 CARTESIA KEYS PARSER & SMART AUTO-PAIRING POOL
// ============================================================================
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

    const silenceSamples = Math.floor(sampleRate * 0.25);
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
        const timer = setTimeout(() => controller.abort(), 10500);
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

// Layer 4 Emergency 18-Emotion Local Hindi Fallback
function generateEmergencyEmotionReply(userText, requestedEmotion, singingMode) {
    const emo = requestedEmotion || (singingMode ? "singing" : detectUniversalHumanEmotion(userText, ""));
    const bank = {
        happiness: "वाह बेटा, तुम्हारी खुशी सुनकर मेरा दिल भी बाग-बाग हो गया! भगवान करे तुम्हारे जीवन में ऐसे ही खुशियाँ आती रहें।",
        sadness: "अरे बेटा, उदास मत हो, मैं तुम्हारी बात समझ रहा हूँ। हर कठिन समय गुजर जाता है, हिम्मत रखो और अपना ख्याल रखो।",
        anger: "बेटा, लापरवाही बिल्कुल अच्छी बात नहीं है, समय और काम की कद्र करना सीखो। आगे से ध्यान रखना, ठीक है?",
        fear: "बेटा, डरने की कोई बात नहीं है। गहरी सांस लो, शांत मन से सोचो और पूरे साहस के साथ आगे बढ़ो।",
        surprise: "अरे वाह बेटा, यह तो सच में बड़ी हैरानी और खुशी की बात है! जल्दी बताओ क्या खास बात है?",
        disgust: "हाँ बेटा, गंदगी और बुरी चीज़ों से मन खराब होना स्वाभाविक है। हमें खुद स्वच्छता और अच्छे विचारों को अपनाना चाहिए।",
        anticipation: "बहुत बढ़िया बेटा, अच्छे अवसर का इंतज़ार हमेशा मीठा होता है। अपनी तैयारी पूरी रखो, शुभ समय ज़रूर आएगा।",
        trust: "बेटा, खुद पर और सच्चाई पर भरोसा रखना ही सबसे बड़ी ताकत है। तुम्हारा यही विश्वास तुम्हें आगे बढ़ाएगा।",
        love: "बेटा, परिवार का प्यार और अपनापन ही दुनिया की सबसे बड़ी दौलत है। सबके साथ मिल-जुलकर खुश रहो।",
        jealousy: "बेटा, दूसरों की तरक्की से ईर्ष्या करने के बजाय उनसे सीख लेकर अपनी मेहनत बढ़ाओ। तुम्हारा समय भी ज़रूर आएगा।",
        shame: "बेटा, इसमें शर्म या झिझक की कोई बात नहीं है। इंसान अनुभव से ही आत्मविश्वास सीखता है, सिर उठाकर आगे बढ़ो।",
        guilt: "बेटा, गलती इंसान से ही होती है, लेकिन उसे मान लेना और सुधारना सबसे बड़ी समझदारी है। मन हल्का करो और आगे सही करो।",
        pride: "शाबाश बेटा! तुम्हारी मेहनत और लगन देखकर मुझे बहुत गर्व हो रहा है। ऐसे ही ऊँचाइयाँ छूते रहो।",
        hope: "बेटा, उम्मीद की किरण कभी मत छोड़ना। मेहनत और अच्छे कर्मों का फल हमेशा मीठा और उज्ज्वल होता है।",
        disappointment: "निराश मत हो बेटा, एक बार काम न बनने का मतलब हार नहीं होता। थोड़ी देर आराम करो और नए जोश से फिर कोशिश करो।",
        empathy: "बेटा, दूसरों का दुख समझना बहुत बड़े दिल की निशानी है। तुम्हारी यह संवेदनशीलता तुम्हें एक नेक इंसान बनाती है।",
        compassion: "बेटा, ज़रूरतमंद की मदद करना और करुणा रखना सबसे बड़ा धर्म है। जितना हो सके, विनम्रता से सबका भला करो।",
        anxiety: "बेटा, इतनी बेचैनी और टेंशन मत लो। एक गिलास पानी पियो, गहरी सांस लो और एक बार में सिर्फ़ एक ही काम पर ध्यान दो।",
        blessing: "सदा खुश रहो बेटा, खूब तरक्की करो और हमेशा स्वस्थ व सुरक्षित रहो।",
        laughing: "हाहा, क्या बढ़िया बात कही तुमने बेटा! ऐसे ही हँसते-मुस्कुराते रहा करो।",
        singing: "अच्छा बेटा, सुनो... सुख के सब साथी, दुख में न कोईऽऽ... मेरे राम, मेरे राम, तेरा नाम एक साँचा, दूजा न कोईऽऽ...",
        caring: "अपना पूरा ध्यान रखो बेटा, समय पर खाना खाओ और पर्याप्त आराम करो।",
        talking: "मैं बिल्कुल ठीक हूँ बेटा, तुम बताओ कैसे हो और घर में सब कैसे हैं?"
    };

    return {
        aiText: ensureCompleteHindiSentence(bank[emo] || bank.talking),
        emotion: emo,
        geminiKeyUsed: "Local-Shield",
        modelUsed: "18-Emotion-Offline-Shield"
    };
}

// 4-Layer Unbreakable Backup Generator: Multi-Key Groq -> OpenRouter -> Pollinations (402-safe) -> Local Shield
async function generateFreeBackupReply(
    userText,
    base64Frame,
    currentFacingMode,
    savedFaces,
    chatHistory,
    longTermMemory,
    singingMode,
    requestedEmotion,
    skippedTelemetry
) {
    let familyHint = "";
    if (currentFacingMode === "user" && Array.isArray(savedFaces) && savedFaces.length > 0) {
        const names = savedFaces.map((f) => f.name).join(", ");
        familyHint = `\nRegistered family members in household: ${names}.`;
    }

    const emotionHint = requestedEmotion
        ? `\n(Express the human emotion: ${requestedEmotion}. Start your response with [EMO:${requestedEmotion}])`
        : `\n(Start your response with [EMO:emotion_name] from the 18 universal human emotions)`;

    const singingInstruction = singingMode
        ? "\n(IMPORTANT: The family member wants you to SING! Write 4-6 melodic Hindi lines of the requested song/bhajan/lori with musical stretches like आऽऽ..., होऽऽ..., हम्मऽऽ..., and commas/ellipses '...' so the voice clone sings it melodiously!)"
        : "\n(Reply warmly as Papa AGI in 1-3 complete Devanagari Hindi sentences ending with पूर्ण विराम ।)";

    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);

    // LAYER 1: Multi-Key Groq Pool (Fastest Free 14,400 req/day backup)
    const groqKeys = getGroqKeysFromEnv();
    if (groqKeys.length > 0) {
        for (let gAttempt = 0; gAttempt < groqKeys.length; gAttempt++) {
            const activeGroqKey = groqKeys[groqKeyIdx % groqKeys.length];
            groqKeyIdx = (groqKeyIdx + 1) % groqKeys.length;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5500);
            try {
                const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        "Authorization": `Bearer ${activeGroqKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                            { role: "user", content: contextText + `Family member said: "${userText}"` + emotionHint + singingInstruction }
                        ],
                        max_tokens: 360,
                        temperature: 0.72
                    })
                });
                clearTimeout(timer);
                const groqData = await groqRes.json();
                const text = groqData?.choices?.[0]?.message?.content;
                if (groqRes.ok && text) {
                    const parsed = extractEmotionTagAndCleanText(text, userText);
                    return {
                        aiText: parsed.aiText,
                        emotion: requestedEmotion || parsed.emotion,
                        geminiKeyUsed: "Groq-Backup",
                        modelUsed: "Groq-Llama-3.3-70B"
                    };
                }
                if (skippedTelemetry) skippedTelemetry.push(`Groq -> HTTP ${groqRes.status}`);
            } catch (e) {
                clearTimeout(timer);
                if (skippedTelemetry) skippedTelemetry.push(`Groq -> ${e.message}`);
            }
        }
    }

    // LAYER 2: Optional OpenRouter Free Backup (if OPENROUTER_API_KEY is set in Vercel)
    if (process.env.OPENROUTER_API_KEY) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5500);
        try {
            const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "meta-llama/llama-3.3-70b-instruct:free",
                    messages: [
                        { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                        { role: "user", content: contextText + `Family member said: "${userText}"` + emotionHint + singingInstruction }
                    ],
                    max_tokens: 340
                })
            });
            clearTimeout(timer);
            if (orRes.ok) {
                const orData = await orRes.json();
                const text = orData?.choices?.[0]?.message?.content;
                if (text && text.trim()) {
                    const parsed = extractEmotionTagAndCleanText(text, userText);
                    return {
                        aiText: parsed.aiText,
                        emotion: requestedEmotion || parsed.emotion,
                        geminiKeyUsed: "OpenRouter",
                        modelUsed: "Llama-3.3-Free"
                    };
                }
            }
            if (skippedTelemetry) skippedTelemetry.push(`OpenRouter -> HTTP ${orRes.status}`);
        } catch (e) {
            clearTimeout(timer);
            if (skippedTelemetry) skippedTelemetry.push(`OpenRouter -> ${e.message}`);
        }
    }

    // LAYER 3: Pollinations Text-Only (with 1-hour circuit breaker if HTTP 402 Payment Required)
    if (Date.now() >= pollinationsBlockedUntil) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        try {
            const freeRes = await fetch("https://text.pollinations.ai/openai", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openai",
                    messages: [
                        { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                        {
                            role: "user",
                            content: contextText + `Family member now said: "${userText}"` + emotionHint + singingInstruction
                        }
                    ]
                })
            });
            clearTimeout(timer);

            if (freeRes.ok) {
                const freeData = await freeRes.json();
                const reply = freeData?.choices?.[0]?.message?.content;
                if (reply && reply.trim()) {
                    const parsed = extractEmotionTagAndCleanText(reply, userText);
                    return {
                        aiText: parsed.aiText,
                        emotion: requestedEmotion || parsed.emotion,
                        geminiKeyUsed: "Auto-Backup",
                        modelUsed: "Free-AGI-Fast"
                    };
                }
            }
            if (freeRes.status === 402 || freeRes.status === 403) {
                pollinationsBlockedUntil = Date.now() + 60 * 60 * 1000;
            }
            if (skippedTelemetry) skippedTelemetry.push(`Pollinations -> HTTP ${freeRes.status}`);
        } catch (e) {
            clearTimeout(timer);
            if (skippedTelemetry) skippedTelemetry.push(`Pollinations -> ${e.message}`);
        }
    }

    // LAYER 4: Emergency 18-Emotion Offline Hindi Shield
    return generateEmergencyEmotionReply(userText, requestedEmotion, singingMode);
}

async function generateGeminiReplyInternal(body) {
    const geminiLoopStart = Date.now();
    const geminiKeys = getGeminiKeysFromEnv();
    const userText = body.userText || "नमस्ते पापा";
    const base64Frame = body.base64Frame || null;
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
    const longTermMemory = Array.isArray(body.longTermMemory) ? body.longTermMemory : [];

    const rawRequestedEmotion = body.forceEmotion ? String(body.forceEmotion).toLowerCase().trim() : null;
    const normalizedRequested = rawRequestedEmotion
        ? (EMOTION_ALIAS_MAP[rawRequestedEmotion] || rawRequestedEmotion)
        : null;
    const requestedEmotion = normalizedRequested && VALID_UNIVERSAL_EMOTIONS.includes(normalizedRequested)
        ? normalizedRequested
        : null;
    const skippedTelemetry = [];

    const singingMode = isSingingRequest(userText) || requestedEmotion === "singing";
    const { agiAction, newMemoryFact } = detectAgiActionAndMemory(userText);
    const useWebSearch = needsLiveWebSearch(userText);

    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);
    const forcedEmotionPrompt = requestedEmotion
        ? `\n(🎭 TARGET HUMAN EMOTION: Express genuine '${requestedEmotion}' in your Hindi tone and start with [EMO:${requestedEmotion}].)`
        : `\n(🎭 ALWAYS start your reply with the single most accurate [EMO:...] tag from the 18 universal human emotions, followed by a space and your Hindi reply.)`;

    const modePromptSuffix = singingMode
        ? `\n(🎵 SINGING MODE ACTIVE: आपका बच्चा आपसे गाना/भजन/लोरी सुनना चाहता है! मना बिल्कुल मत करें। प्यार से एक छोटी लाइन बोलकर तुरंत 4 से 6 लाइनों का सुरीला हिंदी गीत/भजन देवनागरी में गाकर सुनाएँ। गाने के शब्दों में सुर खींचने के लिए 'आऽऽ...', 'होऽऽ...', 'हम्मऽऽ...', और '...' का प्रयोग करें ताकि आवाज़ बिल्कुल असली गायकी जैसी लगे।)`
        : `\n(अपना जवाब हमेशा 1 से 3 पूरे देवनागरी हिंदी वाक्यों में लिखें और वाक्य को अधूरा न छोड़ें।)`;

    const finalTextPrompt = contextText + `Family member now said: "${userText}"` + forcedEmotionPrompt + modePromptSuffix;

    // Build Multimodal Parts (Attaches family reference faces ONLY on Turn 1 or recognition questions for 60% faster speed!)
    const userParts = [];
    const includeRefFaces = base64Frame &&
        currentFacingMode === "user" &&
        savedFaces.length > 0 &&
        shouldAttachReferenceFaces(userText, chatHistory);

    if (includeRefFaces) {
        userParts.push({ text: "REGISTERED FAMILY MEMBERS REFERENCE PHOTOS:" });
        for (const member of savedFaces.slice(0, 4)) {
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
    userParts.push({ text: finalTextPrompt });

    // Lightweight text-only parts for instant fallback if multimodal vision upload times out
    const textOnlyParts = [{ text: finalTextPrompt }];

    let lastError = geminiKeys.length > 0
        ? "All Gemini keys currently in 65s rate-limit cooldown"
        : "No Gemini keys configured";

    if (geminiKeys.length > 0) {
        if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;

        const modelsToTry = await getAutoUpdatedGeminiModelsList(geminiKeys[geminiKeyIdx]);
        let skippedDueToCooldownCount = 0;
        let hitTimeBudget = false;
        let useTextOnlyFallbackMode = false;

        for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
            if (Date.now() - geminiLoopStart > 13500) {
                hitTimeBudget = true;
                break;
            }

            const activeKey = geminiKeys[geminiKeyIdx];
            const keyNum = geminiKeyIdx + 1;
            let keyAuthFailed = false;

            for (const modelName of modelsToTry) {
                if (keyAuthFailed) break;
                if (Date.now() - geminiLoopStart > 13500) {
                    hitTimeBudget = true;
                    break;
                }

                const cacheKey = `${activeKey.slice(-6)}:${modelName}`;
                const exhaustedUntil = exhaustedModelCache.get(cacheKey) || 0;
                if (Date.now() < exhaustedUntil) {
                    skippedDueToCooldownCount++;
                    continue;
                }

                const toolModes = useWebSearch ? [true, false] : [false];

                for (const withSearchTool of toolModes) {
                    const controller = new AbortController();
                    const timeoutMs = useTextOnlyFallbackMode ? 5500 : 10500;
                    const timer = setTimeout(() => controller.abort(), timeoutMs);
                    try {
                        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
                        const payload = {
                            contents: [{ role: "user", parts: useTextOnlyFallbackMode ? textOnlyParts : userParts }],
                            systemInstruction: { parts: [{ text: FATHER_AGI_PROMPT }] },
                            generationConfig: {
                                maxOutputTokens: 420,
                                temperature: singingMode ? 0.8 : 0.7
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
                        const partsList = data?.candidates?.[0]?.content?.parts || [];
                        const combinedText = partsList
                            .map((p) => p.text || "")
                            .join(" ")
                            .trim();

                        if (gRes.ok && combinedText) {
                            const parsed = extractEmotionTagAndCleanText(combinedText, userText);
                            return {
                                aiText: parsed.aiText,
                                emotion: requestedEmotion || parsed.emotion,
                                geminiKeyUsed: keyNum,
                                modelUsed: withSearchTool
                                    ? `${modelName}+WebSearch`
                                    : (useTextOnlyFallbackMode ? `${modelName}(Fast)` : modelName),
                                agiAction,
                                newMemoryFact,
                                skippedTelemetry
                            };
                        }

                        if (withSearchTool && gRes.status === 400) {
                            continue;
                        }

                        lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;
                        skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> HTTP ${gRes.status}`);

                        if (gRes.status === 404) {
                            exhaustedModelCache.set(cacheKey, Date.now() + 6 * 60 * 60 * 1000);
                            break;
                        }
                        if (gRes.status === 429 || gRes.status === 400) {
                            exhaustedModelCache.set(cacheKey, Date.now() + 65 * 1000);
                            break;
                        }
                        if (gRes.status === 401 || gRes.status === 403) {
                            keyAuthFailed = true;
                            break;
                        }
                    } catch (err) {
                        clearTimeout(timer);
                        lastError = err.message;
                        skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> ${err.message}`);
                        // If multimodal Vision request timed out, immediately switch next attempt to ultra-fast Text-Only!
                        if (!useTextOnlyFallbackMode && base64Frame) {
                            useTextOnlyFallbackMode = true;
                            skippedTelemetry.push("Vision timeout -> Retrying Gemini Text-Only (Fast)");
                        }
                        break;
                    }
                }
            }

            const shifted = shiftPingPongIndex(geminiKeyIdx, geminiKeyDir, geminiKeys.length);
            geminiKeyIdx = shifted.idx;
            geminiKeyDir = shifted.dir;
        }

        if (hitTimeBudget) {
            skippedTelemetry.push("Gemini retry loop hit 13.5s budget -> Shifting to Backup Brain");
        } else if (skippedDueToCooldownCount > 0 && skippedTelemetry.length === 0) {
            skippedTelemetry.push(`Gemini ${geminiKeys.length} keys cooling down (65s RPM window) -> Using Backup Brain`);
        }
    }

    const backupReply = await generateFreeBackupReply(
        userText,
        base64Frame,
        currentFacingMode,
        savedFaces,
        chatHistory,
        longTermMemory,
        singingMode,
        requestedEmotion,
        skippedTelemetry
    );
    if (backupReply) {
        backupReply.agiAction = agiAction;
        backupReply.newMemoryFact = newMemoryFact;
        backupReply.skippedTelemetry = skippedTelemetry;
        return backupReply;
    }

    throw new Error(`Gemini API Error (${geminiKeys.length} keys tried): ${lastError}`);
}

async function generateTtsAudioInternal(rawText) {
    const cleanedForVoice = String(rawText || "")
        .replace(/\[(?:EMO|EMOTION)\s*:\s*[a-zA-Z_]+\]/gi, "")
        .replace(/[🎵🎶🎼🎤✨❤️😊😢😠😨😲🤢⏳🤝😒😳😔🏆🌟😞🫂💗😰🙏🙌😄🗣️🤔🎧]/g, "");
    const text = ensureCompleteHindiSentence(cleanedForVoice);
    const { pool: cartesiaPool } = getCartesiaPoolFromEnv();
    const renderUrl = (process.env.RENDER_TTS_URL || "https://papa-voice-cloud.onrender.com/api/tts").trim();
    let lastCartesiaError = "No Cartesia keys configured";

    if (cartesiaPool.length > 0) {
        if (cartesiaKeyIdx >= cartesiaPool.length) cartesiaKeyIdx = 0;

        for (let attempt = 0; attempt < cartesiaPool.length; attempt++) {
            const entry = cartesiaPool[cartesiaKeyIdx];
            const keyNum = cartesiaKeyIdx + 1;

            const result = await tryKeyAcrossAllVoices(entry, text);
            if (result.ok) {
                return {
                    audioBase64: result.audioBase64,
                    engineLabel: `Cartesia Key #${keyNum}/${cartesiaPool.length} (Voice #${result.voiceNum} - ${result.modelUsed})`
                };
            }

            lastCartesiaError = `Key #${keyNum} V#${result.voiceNum || 1} [${result.status}]: ${result.error}`;

            const shifted = shiftPingPongIndex(cartesiaKeyIdx, cartesiaKeyDir, cartesiaPool.length);
            cartesiaKeyIdx = shifted.idx;
            cartesiaKeyDir = shifted.dir;
        }
    }

    const rRes = await fetch(renderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, length_scale: 1.12 })
    });

    if (rRes.ok) {
        const rawWav = await rRes.arrayBuffer();
        const cleanWav = buildWavBufferFromPcm(rawWav, 22050);
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
    const requiredPin = (process.env.APP_PIN || "1234").trim();

    if (action === "verify_pin") {
        const enteredPin = String(body.pin || "").trim();
        if (enteredPin === requiredPin) {
            const gKeys = getGeminiKeysFromEnv();
            const discovered = gKeys.length > 0 ? await getAutoUpdatedGeminiModelsList(gKeys[0]) : NOV_2026_ACTIVE_MODELS;
            return res.status(200).json({
                ok: true,
                releaseBaseUrl: getNormalizedReleaseBaseUrl(),
                autoDiscoveredModels: discovered.slice(0, 5)
            });
        }
        return res.status(401).json({ ok: false, error: "Wrong PIN" });
    }

    if (String(body.pin || "").trim() !== requiredPin) {
        return res.status(401).json({ error: "Unauthorized PIN" });
    }

    if (action === "chat_and_tts") {
        try {
            const t0 = Date.now();
            const chatResult = await generateGeminiReplyInternal(body);
            const geminiMs = Date.now() - t0;

            const t1 = Date.now();
            const ttsResult = await generateTtsAudioInternal(chatResult.aiText);
            const ttsMs = Date.now() - t1;

            const brainBadge = typeof chatResult.geminiKeyUsed === "number"
                ? `G-Key #${chatResult.geminiKeyUsed}`
                : chatResult.geminiKeyUsed;

            return res.status(200).json({
                aiText: chatResult.aiText,
                emotion: chatResult.emotion || "talking",
                geminiKeyUsed: chatResult.geminiKeyUsed,
                modelUsed: chatResult.modelUsed,
                agiAction: chatResult.agiAction || null,
                newMemoryFact: chatResult.newMemoryFact || null,
                audioBase64: ttsResult.audioBase64,
                engineLabel: `${brainBadge} (${chatResult.modelUsed}) | ${ttsResult.engineLabel}`,
                telemetry: {
                    totalMs: Date.now() - startTimeMs,
                    geminiMs,
                    ttsMs,
                    skippedAttempts: chatResult.skippedTelemetry || []
                }
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (action === "chat") {
        try {
            const chatResult = await generateGeminiReplyInternal(body);
            return res.status(200).json(chatResult);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (action === "tts") {
        const text = (body.text || "").trim();
        if (!text) {
            return res.status(400).json({ error: "Empty text for TTS" });
        }
        try {
            const ttsResult = await generateTtsAudioInternal(text);
            return res.status(200).json({
                ...ttsResult,
                emotion: body.forceEmotion || detectUniversalHumanEmotion("", text)
            });
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }

    if (action === "diag") {
        const geminiKeys = getGeminiKeysFromEnv();
        const groqKeys = getGroqKeysFromEnv();
        const { pool: cartesiaPool, allVoices } = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        const liveModels = geminiKeys.length > 0
            ? await getAutoUpdatedGeminiModelsList(geminiKeys[0])
            : NOV_2026_ACTIVE_MODELS;

        logs.push(`🔄 AUTO-DISCOVERED LIVE GEMINI MODELS (High-Quota First): ${liveModels.slice(0, 5).join(", ")}`);
        logs.push(`🎭 UNIVERSAL EMOTIONS LOADED: 18 Human Emotions + 5 Papa States`);
        logs.push(`🧠 GEMINI KEYS FOUND: ${geminiKeys.length} | ⚡ GROQ BACKUP KEYS FOUND: ${groqKeys.length}`);

        for (let g = 0; g < geminiKeys.length; g++) {
            const gKey = geminiKeys[g];
            const masked = gKey.slice(0, 6) + "..." + gKey.slice(-4);
            let keyWorked = false;
            let lastGStatus = "";

            for (const testModel of liveModels.slice(0, 3)) {
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
                logs.push(`⚠️ Gemini Key #${g + 1} (${masked}): Quota Full (${lastGStatus}) -> Backup AI Ready`);
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
                logs.push(`✅ Key #${k + 1} (${maskedKey}) ➔ Matched Voice #${resTest.voiceNum} (${resTest.modelUsed}): SUCCESS!`);
                if (!firstSuccessAudio) {
                    firstSuccessAudio = resTest.audioBase64;
                    cartesiaKeyIdx = k;
                    activeKeyLabel = `Gemini (${geminiKeys.length} Keys) + Cartesia Key #${k + 1}/${cartesiaPool.length} (Voice #${resTest.voiceNum})`;
                }
            } else {
                logs.push(`❌ Key #${k + 1} (${maskedKey}): HTTP ${resTest.status} - ${resTest.error}`);
            }
        }

        return res.status(200).json({
            logs,
            foundWorking: Boolean(firstSuccessAudio),
            activeKeyLabel,
            audioBase64: firstSuccessAudio
        });
    }

    return res.status(400).json({ error: "Invalid action" });
}
