// cloud/main.js
// Docly — Cloud Code : génération réelle du contenu via l'API Groq
// La clé API est lue depuis une variable d'environnement Back4app (jamais écrite ici).

// Répartition par étape du pipeline (plan gratuit Groq : 8K tokens/min PAR modèle)
const MODELS = {
  A: { primary: "openai/gpt-oss-20b", fallback: "qwen/qwen3.8-27b" },   // lecture des morceaux
  B: { primary: "qwen/qwen3.8-27b", fallback: "openai/gpt-oss-20b" },   // fusion des notes
  C: { primary: "openai/gpt-oss-120b", fallback: "qwen/qwen3.8-27b" }   // rédaction finale
};
const MAX_OUT = { A: 900, B: 1100, C: 3000 };
const MAX_SERVER_WAIT = 8; // secondes : au-delà, on laisse le client attendre (limite Back4app = 60 s)
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SPREADSHEET_TYPES = new Set(["xlsx", "xls", "csv"]);

// Instructions communes sur la manière de citer les sources, adaptées au type de fichier
function citationInstructions(fileType) {
  const isSheet = SPREADSHEET_TYPES.has((fileType || "").toLowerCase());
  if (isSheet) {
    return (
      "Le document est un tableur. Chaque entrée de 'sources' doit avoir un champ 'cell' " +
      "(ex. \"Sheet1!B4\") indiquant la cellule exacte d'où vient l'information, et un champ 'note' " +
      "décrivant brièvement ce que contient cette cellule."
    );
  }
  return (
    "Le texte du document contient des marqueurs \"[[page N]]\" indiquant le début de chaque page. " +
    "Chaque entrée de 'sources' doit avoir un champ 'page' (le vrai numéro de page pris dans ces marqueurs, " +
    "jamais inventé) et un champ 'paragraph' (numéro approximatif du paragraphe dans la page), plus un champ " +
    "'note' décrivant brièvement le passage source."
  );
}

const INLINE_CITATION_RULE =
  "Chaque affirmation tirée du document doit être suivie d'un marqueur \"[n]\" (ex. \"Le chiffre d'affaires a " +
  "augmenté de 27 %. [1]\") où n est la position (à partir de 1) de la source correspondante dans le tableau " +
  "'sources'. Insère ces marqueurs directement dans le texte du champ 'content' (ou dans chaque élément si " +
  "'content' est une liste). N'invente jamais un numéro qui ne correspond à aucune entrée de 'sources'.";

// Résultat attendu pour chaque action × preset (repris tel quel du cahier des charges Docly)
const EXPECTED = {
  summarize: {
    court: "Une synthèse très concise du document.",
    detaille: "Une synthèse complète avec les idées et informations importantes.",
    professionnel: "Un résumé structuré et formulé dans un style professionnel.",
    tableau: "Les informations essentielles du résumé organisées dans un tableau.",
    presentation: "Le résumé transformé en diapositives structurées.",
    quiz: "Un questionnaire généré à partir des informations du résumé/document.",
    flashcards: "Des cartes question/réponse basées sur les informations importantes."
  },
  "action-items": {
    court: "Les actions principales uniquement.",
    detaille: "Toutes les actions/prochaines étapes identifiées avec leur contexte.",
    professionnel: "Liste d'actions claire et structurée pour une utilisation professionnelle.",
    tableau: "Actions présentées dans un tableau, par exemple : action / responsable / échéance lorsqu'ils sont présents dans le document.",
    presentation: "Les actions transformées en diapositives.",
    quiz: "Questions permettant de vérifier les actions à réaliser.",
    flashcards: "Cartes permettant de mémoriser les actions et prochaines étapes."
  },
  ask: {
    court: "Réponses courtes et directement basées sur le document.",
    detaille: "Réponses développées avec davantage de contexte et de sources.",
    professionnel: "Réponses formulées dans un style professionnel.",
    tableau: "Les réponses et informations demandées présentées sous forme de tableau lorsque cela est pertinent.",
    presentation: "Les réponses importantes organisées sous forme de présentation.",
    quiz: "Une série de questions/réponses basée sur le document."
  },
  analyze: {
    court: "Les principaux constats de l'analyse.",
    detaille: "Analyse approfondie avec constats, informations importantes et conclusions.",
    professionnel: "Analyse structurée dans un style professionnel/exécutif.",
    tableau: "Résultats de l'analyse organisés en tableau.",
    presentation: "Analyse transformée en présentation structurée.",
    quiz: "Questions générées à partir des éléments analysés.",
    flashcards: "Concepts et informations importantes de l'analyse transformés en cartes."
  },
  extract: {
    court: "Uniquement les données demandées, sans explication inutile.",
    detaille: "Données extraites avec leur contexte et leurs sources.",
    professionnel: "Données présentées proprement pour une utilisation professionnelle.",
    tableau: "Données extraites directement sous forme de tableau.",
    presentation: "Données importantes transformées en diapositives.",
    quiz: "Questions générées à partir des données extraites.",
    flashcards: "Données importantes transformées en cartes question/réponse."
  }
};

const ACTION_SUBJECT = {
  summarize: "Résume fidèlement le document fourni.",
  "action-items": "Travaille sur les actions ou prochaines étapes présentes dans le document.",
  analyze: "Analyse le contenu du document afin d'en faire ressortir les informations pertinentes.",
  extract: "Recherche et extrait les informations importantes (données, chiffres, clauses...) présentes dans le document.",
  ask: "Réponds à partir du contenu du document, STRICTEMENT.",
  transform: "Transforme le contenu du document selon le format demandé."
};

// Construit les instructions données à l'IA selon l'action et le preset choisis dans le wizard
function buildInstructions(action, preset, fileType, mode) {
  const base =
    "Tu es Docly, un assistant qui analyse des documents. " +
    "Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, sans ```.";

  const TEXT = "Le champ 'content' est une chaîne de texte (tu peux utiliser des lignes commençant par '- ' pour des listes et '## ' pour des titres de section).";
  const shapeByPreset = {
    court: "Réponds de façon très concise. " + TEXT,
    detaille: "Réponds de façon complète et détaillée, en plusieurs sections si utile. " + TEXT,
    professionnel: "Réponds dans un style professionnel et formel, bien structuré, prêt à être partagé. " + TEXT,
    tableau: "Réponds avec un tableau de données structuré. Le champ 'content' doit être un objet {\"headers\": [\"...\"], \"rows\": [[\"...\"], [\"...\"]]}.",
    presentation: "Réponds sous forme de diapositives (5 à 8 slides). Le champ 'content' doit être un tableau de slides, chaque slide étant {\"title\": \"...\", \"bullets\": [\"...\"]}.",
    quiz: "Génère un questionnaire de 5 questions à choix multiples. Le champ 'content' doit être un tableau de {\"question\": \"...\", \"options\": [\"...\"], \"correctIndex\": 0}.",
    flashcards: "Génère 8 cartes mémoire. Le champ 'content' doit être un tableau de {\"front\": \"question\", \"back\": \"réponse\"}.",
    paragraphes: "Réponds comme un article ou un document professionnel aéré. Le champ 'content' est une chaîne : chaque section commence par une ligne '## Titre de section' (reprends les titres du document quand ils existent), suivie d'un ou plusieurs paragraphes rédigés naturellement, séparés par une ligne vide. INTERDIT : puces, listes, tirets en début de ligne, numérotation des titres ou des paragraphes.",
    bullets: "Réponds en points clés concis. Le champ 'content' doit être un tableau d'objets {\"text\": \"idée courte\", \"sub\": [\"détail\", \"détail\"]} ('sub' peut être vide). Termine chaque 'text' et chaque élément de 'sub' par un marqueur [n].",
    faq: "Réponds sous forme de FAQ de 6 à 10 questions. Le champ 'content' doit être un tableau d'objets {\"question\": \"...\", \"answer\": \"...\"}. Termine chaque 'answer' par un marqueur [n].",
    plan: "Réponds sous forme de plan structuré du contenu. Le champ 'content' doit être un tableau d'objets {\"title\": \"...\", \"ref\": n, \"children\": [{\"title\": \"...\", \"ref\": n}]} où 'ref' est la position (à partir de 1) de la source correspondante dans 'sources'. N'ajoute pas de numérotation dans les titres.",
    "fiche-revision": "Réponds sous forme de fiche de révision structurée (titres, définitions, points clés). " + TEXT,
    rapport: "Réponds sous forme de rapport professionnel structuré (introduction, sections, conclusion). " + TEXT
  };

  const citationRule = citationInstructions(fileType);
  const noMarkerRule =
    "Pour les formes quiz et cartes mémoire, n'insère pas de marqueurs [n] dans les questions/réponses : renseigne seulement 'sources'.";
  const subject = ACTION_SUBJECT[action] || "Traite le document selon la demande de l'utilisateur.";

  // ---- Q/R en chat : la réponse est toujours une chaîne, dont le style suit le preset ----
  if (mode === "chat") {
    const style = (EXPECTED.ask[preset]) || "Réponse claire basée sur le document.";
    let form = "Le champ 'content' est une chaîne de texte.";
    if (preset === "tableau") form = "Si pertinent, présente les informations sous forme de tableau markdown (lignes commençant par '|', avec une ligne d'en-tête et une ligne '|---|---|'). Le champ 'content' est une chaîne de texte.";
    if (preset === "paragraphes") form = "Réponds en paragraphes rédigés, sans puces ni listes. Le champ 'content' est une chaîne de texte.";
    if (preset === "bullets") form = "Réponds avec des lignes commençant par '- '. Le champ 'content' est une chaîne de texte.";
    if (preset === "faq") form = "Structure la réponse en questions/réponses : chaque question sur une ligne '## Question' suivie de sa réponse. Le champ 'content' est une chaîne de texte.";
    if (preset === "plan") form = "Structure la réponse en plan : lignes '## Titre' suivies de lignes '- ' pour les sous-points. Le champ 'content' est une chaîne de texte.";
    if (preset === "presentation") form = "Organise la réponse en sections façon diapositives : chaque section commence par une ligne '## Titre' suivie de lignes '- '. Le champ 'content' est une chaîne de texte.";
    return `${base}\n${subject}\nRésultat attendu : ${style}\n${form}\n${citationRule}\n${INLINE_CITATION_RULE}`;
  }

  // ---- Q/R statique (preset Questionnaire) : liste de questions/réponses ----
  if (mode === "qa") {
    return `${base}\n${subject}\nRésultat attendu : ${EXPECTED.ask.quiz}\n` +
      "Le champ 'content' doit être un tableau de 6 à 10 objets {\"question\": \"...\", \"answer\": \"...\"} basés sur le document. " +
      `Dans chaque 'answer', termine par un marqueur [n] renvoyant à 'sources'.\n${citationRule}\n${INLINE_CITATION_RULE}`;
  }

  // ---- Toutes les autres actions : forme du preset + résultat attendu propre à l'action ----
  const expected = EXPECTED[action] && EXPECTED[action][preset];
  const expectedLine = expected ? `Résultat attendu : ${expected}\n` : "";
  const shape = shapeByPreset[preset] || ("Réponds sous forme de texte clair et bien structuré. " + TEXT);
  const inlineRule = preset === "plan"
    ? "Pour le plan, n'insère aucun marqueur [n] dans les titres : utilise uniquement le champ 'ref'."
    : INLINE_CITATION_RULE;
  return `${base}\n${subject}\n${expectedLine}${shape}\n${citationRule}\n${inlineRule}\n${noMarkerRule}`;
}

function buildCompareInstructions(fileTypes) {
  const anySheet = (fileTypes || []).some((t) => SPREADSHEET_TYPES.has((t || "").toLowerCase()));
  const citationRule = anySheet
    ? "Pour les documents tableurs, utilise un champ 'cell' dans 'sources' ; pour les autres, utilise 'page' et 'paragraph'."
    : "Utilise les marqueurs \"[[page N]]\" présents dans chaque document pour citer un champ 'page' réel, plus un champ 'paragraph' approximatif.";
  return (
    "Tu es Docly, un assistant qui compare plusieurs documents. " +
    "Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, sans ```. " +
    "Compare les documents fournis et fais ressortir leurs similitudes et leurs différences. " +
    "Le champ 'content' doit être une chaîne de texte détaillée, rédigée en paragraphes (pas de puces, pas de listes, pas de numérotation) : une section '## Points communs' puis une section '## Différences', chacune avec plusieurs paragraphes développés qui reprennent les titres des documents quand ils existent. " +
    "Chaque entrée de 'sources' doit inclure un champ 'docName' indiquant de quel document elle provient. " +
    citationRule + "\n" + INLINE_CITATION_RULE
  );
}

function mkErr(kind, message, retryAfter) {
  const e = new Error(message || kind);
  e.kind = kind;
  if (retryAfter != null) e.retryAfter = retryAfter;
  return e;
}

// Lit des durées du type "2m59.56s", "7.66s", "1h2m", "250ms"
function parseDuration(str) {
  if (!str) return null;
  const s = String(str);
  if (/^\d+(\.\d+)?$/.test(s.trim())) return parseFloat(s);
  let total = 0, found = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(s))) {
    found = true;
    const v = parseFloat(m[1]);
    total += m[2] === "h" ? v * 3600 : m[2] === "m" ? v * 60 : m[2] === "ms" ? v / 1000 : v;
  }
  return found ? total : null;
}

function parseRetryAfter(res, bodyText) {
  const h = parseDuration(res.headers.get("retry-after"));
  if (h != null) return h;
  const m = /try again in ([0-9hms.\s]+)/i.exec(bodyText || "");
  const b = m ? parseDuration(m[1]) : null;
  return b != null ? b : null;
}

function cleanOutput(raw) {
  return String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseJsonLoose(raw) {
  let s = cleanOutput(raw).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
  }
  throw mkErr("badoutput", "La réponse de l'IA n'était pas un JSON valide.");
}

// Un appel Groq pour un modèle donné
// Prompt caching Groq : le début de la requête (consigne fixe + document) doit rester identique d'un appel à l'autre.
const CACHE_SYSTEM = "Tu es Docly, un assistant d'analyse documentaire. Le document est fourni en premier, puis une section « CONSIGNES » précise la tâche à accomplir : suis-la scrupuleusement.";

async function groqChat(apiKey, model, messages, opts) {
  const body = {
    model: model,
    messages: messages,
    temperature: 0.3,
    max_completion_tokens: opts.maxTokens
  };
  if (model.indexOf("openai/gpt-oss") === 0) {
    body.reasoning_effort = "low"; // limite les tokens de raisonnement (comptés dans les limites)
    if (opts.json) body.response_format = { type: "json_object" };
  }

  let res, text;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw mkErr("network", "Impossible de contacter Groq : " + err.message);
    }
    text = await res.text();
    // Paramètre optionnel refusé par un modèle : on réessaie une fois sans
    if (res.status === 400 && attempt === 0 &&
        /reasoning_effort|response_format|max_completion_tokens|unsupported|unknown/i.test(text) &&
        !/too large|reduce/i.test(text)) {
      delete body.reasoning_effort;
      delete body.response_format;
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
      continue;
    }
    break;
  }

  if (res.status === 429) throw mkErr("rate", "Limite Groq atteinte (" + model + ")", parseRetryAfter(res, text));
  if (res.status === 413 || (res.status === 400 && /too large|reduce (the length|your message)|context length/i.test(text))) {
    throw mkErr("toolarge", "Requête trop volumineuse pour " + model);
  }
  if (res.status === 404 || res.status >= 500) throw mkErr("unavailable", "Modèle indisponible (" + model + ", " + res.status + ")");
  if (!res.ok) throw mkErr("other", "Erreur Groq (" + res.status + ") : " + text.slice(0, 300));

  let data;
  try { data = JSON.parse(text); } catch (e) { throw mkErr("badoutput", "Réponse Groq mal formée."); }
  const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const out = cleanOutput(raw);
  if (!out) throw mkErr("badoutput", "Réponse Groq vide.");
  return opts.json ? parseJsonLoose(out) : out;
}

// Appel d'une étape : modèle principal, puis modèle de secours. Les longues attentes sont laissées au client.
async function callStage(stage, messages, opts) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Clé Groq non configurée côté serveur (variable GROQ_API_KEY manquante).");
  }
  const options = { json: !!opts.json, maxTokens: opts.maxTokens || MAX_OUT[stage] };
  const order = [MODELS[stage].primary, MODELS[stage].fallback];
  let minRetry = null, lastErr = null;

  for (let i = 0; i < order.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await groqChat(apiKey, order[i], messages, options);
      } catch (e) {
        lastErr = e;
        if (e.kind === "toolarge") {
          throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "TOO_LARGE");
        }
        if (e.kind === "rate") {
          if (e.retryAfter != null && e.retryAfter <= MAX_SERVER_WAIT && attempt === 0) {
            await new Promise((r) => setTimeout(r, e.retryAfter * 1000 + 300));
            continue;
          }
          const ra = e.retryAfter != null ? e.retryAfter : 20;
          minRetry = minRetry == null ? ra : Math.min(minRetry, ra);
          break; // modèle suivant
        }
        if ((e.kind === "network" || e.kind === "other") && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break; // modèle suivant
      }
    }
  }
  if (minRetry != null) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "RATE_LIMIT:" + Math.ceil(minRetry));
  }
  throw new Parse.Error(Parse.Error.SCRIPT_FAILED, (lastErr && lastErr.message) || "Erreur IA inconnue.");
}

// ---------------------------------------------------------------------------
// ÉTAPE A — lecture d'un morceau du document → notes fidèles avec leurs pages
// ---------------------------------------------------------------------------
const A_SYSTEM =
  "Tu es Docly. Tu lis un extrait d'un document et tu en fais des notes fidèles et denses, dans la langue du document. " +
  "Conserve les faits, chiffres, noms, dates, définitions, décisions, clauses, actions et conclusions. N'invente rien, ne commente pas. " +
  "Le texte contient des marqueurs [[page N]] ou des titres de feuille '## Nom'. Chaque note est une ligne qui commence par '- ' suivie " +
  "du marqueur de son emplacement recopié tel quel, par exemple '- [[page 4]] Le chiffre d'affaires a augmenté de 27 %.' " +
  "(pour un tableur : '- [[Nom de la feuille]] ...'). N'utilise jamais un numéro de page qui n'apparaît pas dans l'extrait. " +
  "Réponds uniquement avec ces lignes, 600 mots maximum.";

Parse.Cloud.define("analyzeChunk", async (request) => {
  const { text, fileName } = request.params;
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Aucun texte extrait à analyser.");
  }
  const notes = await callStage(
    "A",
    [
      { role: "system", content: A_SYSTEM },
      { role: "user", content: `Document : "${fileName || "document"}"\n\nExtrait :\n"""\n${text}\n"""` }
    ],
    { json: false, maxTokens: MAX_OUT.A }
  );
  return { notes };
});

// ---------------------------------------------------------------------------
// ÉTAPE B — fusion de plusieurs séries de notes en une seule, plus courte
// ---------------------------------------------------------------------------
const B_SYSTEM =
  "Tu fusionnes plusieurs séries de notes issues d'un même document en un seul ensemble plus court : supprime les doublons, " +
  "regroupe ce qui va ensemble, garde tous les chiffres, noms, dates, décisions et actions importants, et conserve devant chaque " +
  "note son marqueur [[page N]] (ou [[Nom de la feuille]]) tel qu'il est écrit. Ne crée jamais un marqueur nouveau. " +
  "Format : des lignes '- [[page N]] note'. 450 mots maximum. Réponds uniquement avec ces lignes.";

Parse.Cloud.define("mergeNotes", async (request) => {
  const { notes, fileName } = request.params;
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Aucune note à fusionner.");
  }
  const merged = await callStage(
    "B",
    [
      { role: "system", content: B_SYSTEM },
      { role: "user", content: `Document : "${fileName || "document"}"\n\n` + notes.join("\n\n") }
    ],
    { json: false, maxTokens: MAX_OUT.B }
  );
  return { notes: merged };
});

// ---------------------------------------------------------------------------
// ÉTAPE C — rédaction du résultat final (formats, citations : inchangés)
// ---------------------------------------------------------------------------
Parse.Cloud.define("generateDocumentResult", async (request) => {
  const { text, action, preset, fileName, fileType, language, question, documents, condensed } = request.params;
  if (request.user && action && action !== "compare") {
    const planUser = await freshUser(request.user);
    if (!PLAN_RULES[effectivePlanKey(planUser)].actions.includes(action)) throw planError("ACTION");
  }

  if (!action) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Action manquante (summarize, analyze, ask, extract, action-items, transform, compare).");
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Clé Groq non configurée côté serveur (variable GROQ_API_KEY manquante).");
  }

  const langInstruction = language ? `Réponds en ${language}.` : "Réponds en français.";
  const condensedNote = condensed
    ? "\n(Le contenu du document est un ensemble de notes condensées couvrant tout le document ; les marqueurs [[page N]] sont conservés.)"
    : "";

  // ---- Comparaison de plusieurs documents ----
  if (action === "compare") {
    if (!Array.isArray(documents) || documents.length < 2) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Il faut au moins deux documents pour une comparaison.");
    }
    const systemPrompt = buildCompareInstructions(documents.map((d) => d.fileType));
    const docsBlock = documents
      .map((d, i) => `### Document ${i + 1} : "${d.fileName || "document " + (i + 1)}"\n"""\n${d.text || ""}\n"""`)
      .join("\n\n");
    const userPrompt =
      `${docsBlock}\n\n=== CONSIGNES ===\n${systemPrompt}\n\n${langInstruction}${condensedNote}\n\n` +
      `Réponds STRICTEMENT avec un objet JSON de cette forme :\n` +
      `{"content": "## Points communs\\n\\nparagraphes...\\n\\n## Différences\\n\\nparagraphes...", "sources": [{"docName": "...", "page": 0, "paragraph": 0, "cell": "...", "note": "..."}]}`;
    const parsed = await callStage(
      "C",
      [{ role: "system", content: CACHE_SYSTEM }, { role: "user", content: userPrompt }],
      { json: true, maxTokens: MAX_OUT.C }
    );
    if (!parsed.content) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA ne contient pas de champ 'content'.");
    }
    return { content: parsed.content, sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
  }

  // ---- Génération sur un seul document ----
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Aucun texte extrait à analyser.");
  }

  const mode = action === "ask" ? (question ? "chat" : (preset === "quiz" ? "qa" : "chat")) : "standard";
  const systemPrompt = buildInstructions(action, preset, fileType, mode);
  const questionPart = question ? `\n\nQuestion de l'utilisateur : "${question}"` : "";

  const userPrompt =
    `Document : "${fileName || "document"}"\n\n` +
    `Contenu du document :\n"""\n${text}\n"""\n\n` +
    `=== CONSIGNES ===\n${systemPrompt}\n\n${langInstruction}${condensedNote}${questionPart}\n\n` +
    `Réponds STRICTEMENT avec un objet JSON de cette forme :\n` +
    `{"content": <voir consignes ci-dessus>, "sources": [{"page": <numéro de page réel>, "paragraph": <numéro approximatif>, "cell": "<uniquement pour un tableur>", "note": "<courte description>"}]}`;

  const parsed = await callStage(
    "C",
    [{ role: "system", content: CACHE_SYSTEM }, { role: "user", content: userPrompt }],
    { json: true, maxTokens: MAX_OUT.C }
  );
  if (!parsed.content) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA ne contient pas de champ 'content'.");
  }

  return {
    content: parsed.content,
    sources: Array.isArray(parsed.sources) ? parsed.sources : []
  };
});

// ===========================================================================
// PLANS DOCLY — quotas, expiration, paiement Kkiapay (tout est vérifié côté serveur)
// ===========================================================================
const PLAN_RULES = {
  free: { docs: 3, pages: 150, mb: 20, priceUsd: 0, compareDocs: 0, compareMonth: 0,
    formats: ["pdf"], actions: ["summarize", "ask"] },
  pro: { docs: 100, pages: 1000, mb: 100, priceUsd: 9.99, compareDocs: 3, compareMonth: 5,
    formats: ["pdf", "csv", "epub", "xlsx"], actions: ["summarize", "ask", "action-items"] },
  unlimited: { docs: 300, pages: 2500, pagesMonth: 2500, mb: 250, priceUsd: 19.99, compareDocs: 5, compareMonth: 10,
    formats: ["pdf", "csv", "epub", "xlsx", "docx", "pptx", "txt", "md", "png", "jpg", "jpeg", "webp"],
    actions: ["summarize", "analyze", "ask", "extract", "action-items", "transform"] }
};
const USD_TO_XOF = 600; // doit être identique à index.html

const DAY_MS = 24 * 3600 * 1000;
async function freshUser(user) { return new Parse.Query(Parse.User).get(user.id, { useMasterKey: true }); }
function effectivePlanKey(user) {
  const p = user.get("plan") || "free";
  const exp = user.get("planExpiresAt");
  if (p !== "free" && (!exp || exp < new Date())) return "free"; // plan expiré : retour au gratuit
  return PLAN_RULES[p] ? p : "free";
}
// Cycles de 30 jours : Gratuit depuis l'inscription, plans payants depuis le paiement
function cycleWindow(user, key) {
  const exp = user.get("planExpiresAt");
  const anchor = key === "free"
    ? user.createdAt.getTime()
    : (user.get("planStartedAt") || new Date(exp.getTime() - 30 * DAY_MS)).getTime();
  const n = Math.max(0, Math.floor((Date.now() - anchor) / (30 * DAY_MS)));
  const start = anchor + n * 30 * DAY_MS;
  return { start: new Date(start), end: new Date(start + 30 * DAY_MS) };
}
async function usageCount(user, kind) {
  const win = cycleWindow(user, effectivePlanKey(user));
  const q = new Parse.Query("UsageLog");
  q.equalTo("owner", user); q.equalTo("kind", kind); q.greaterThanOrEqualTo("createdAt", win.start);
  return q.count({ useMasterKey: true });
}
async function pagesUsage(user) {
  const win = cycleWindow(user, effectivePlanKey(user));
  const q = new Parse.Query("UsageLog");
  q.equalTo("owner", user); q.equalTo("kind", "doc"); q.greaterThanOrEqualTo("createdAt", win.start); q.limit(1000);
  const rows = await q.find({ useMasterKey: true });
  return rows.reduce((s, r) => s + (r.get("pages") || 0), 0);
}
async function addUsage(user, kind, docId, pages) {
  const log = new Parse.Object("UsageLog");
  log.set("owner", user); log.set("kind", kind);
  if (docId) log.set("docId", docId);
  if (pages) log.set("pages", pages);
  const acl = new Parse.ACL(); acl.setPublicReadAccess(false); acl.setPublicWriteAccess(false);
  log.setACL(acl);
  await log.save(null, { useMasterKey: true });
}
function planError(code) { return new Parse.Error(Parse.Error.SCRIPT_FAILED, "PLAN:" + code); }

Parse.Cloud.define("getPlanStatus", async (request) => {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, "Not logged in");
  const user = await freshUser(request.user);
  const key = effectivePlanKey(user);
  return {
    plan: key,
    used: await usageCount(user, "doc"),
    limit: PLAN_RULES[key].docs,
    compareUsed: await usageCount(user, "compare"),
    pagesUsed: await pagesUsage(user),
    resetsAt: cycleWindow(user, key).end,
    expiresAt: key === "free" ? null : user.get("planExpiresAt")
  };
});

Parse.Cloud.beforeSave("Document", async (request) => {
  if (request.master || !request.user) return;
  const doc = request.object;
  const user = await freshUser(request.user);
  const rules = PLAN_RULES[effectivePlanKey(user)];
  if (doc.isNew()) {
    const ext = String(doc.get("fileType") || "").toLowerCase();
    if (!rules.formats.includes(ext)) throw planError("FORMAT");
    if ((doc.get("fileSize") || 0) > rules.mb * 1048576) throw planError("SIZE");
    if (rules.docs !== null && (await usageCount(user, "doc")) >= rules.docs) throw planError("QUOTA");
  }
  const pages = doc.get("pageCount");
  if (pages && pages > rules.pages) throw planError("PAGES");
  if (pages && rules.pagesMonth && doc.dirty("pageCount") && (await pagesUsage(user)) + pages > rules.pagesMonth) throw planError("PAGESMONTH");
});

Parse.Cloud.afterSave("Document", async (request) => {
  const doc = request.object;
  const was = request.original ? request.original.get("status") : null;
  if (doc.get("status") !== "ready" || was === "ready") return;
  const owner = doc.get("owner");
  if (!owner) return;
  const dq = new Parse.Query("UsageLog");
  dq.equalTo("kind", "doc"); dq.equalTo("docId", doc.id);
  if (await dq.first({ useMasterKey: true })) return;
  await addUsage(owner, "doc", doc.id, doc.get("pageCount") || 0);
});

Parse.Cloud.define("consumeCompare", async (request) => {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, "Not logged in");
  const user = await freshUser(request.user);
  const rules = PLAN_RULES[effectivePlanKey(user)];
  const count = Number(request.params.count) || 0;
  if (!rules.compareDocs) throw planError("COMPARE");
  if (count > rules.compareDocs) throw planError("COMPAREDOCS");
  if ((await usageCount(user, "compare")) >= rules.compareMonth) throw planError("COMPAREMONTH");
  await addUsage(user, "compare");
  return { ok: true };
});

Parse.Cloud.beforeSave(Parse.User, (request) => {
  if (request.master) return;
  const protectedKeys = ["plan", "planExpiresAt", "planStartedAt"];
  const o = request.object;
  const touched = protectedKeys.some((k) => (o.isNew() ? o.get(k) !== undefined : o.dirty(k)));
  if (touched) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "Not allowed");
});

Parse.Cloud.define("activatePlan", async (request) => {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, "Not logged in");
  const { plan, transactionId } = request.params;
  const rules = PLAN_RULES[plan];
  if (!rules || plan === "free" || !transactionId) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Invalid plan request.");
  const pub = process.env.KKIAPAY_PUBLIC_KEY, priv = process.env.KKIAPAY_PRIVATE_KEY, sec = process.env.KKIAPAY_SECRET;
  if (!pub || !priv || !sec) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Kkiapay keys are not configured on the server.");

  const dup = new Parse.Query("PlanPayment");
  dup.equalTo("transactionId", String(transactionId));
  if (await dup.first({ useMasterKey: true })) throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "This payment was already used.");

  const base = process.env.KKIAPAY_SANDBOX === "false" ? "https://api.kkiapay.me" : "https://api-sandbox.kkiapay.me";
  const res = await fetch(base + "/api/v1/transactions/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": pub, "x-private-key": priv, "x-secret-key": sec },
    body: JSON.stringify({ transactionId })
  });
  const tx = await res.json().catch(() => ({}));
  const expected = Math.round(rules.priceUsd * USD_TO_XOF);
  if (!res.ok || tx.status !== "SUCCESS" || Number(tx.amount) < expected * 0.95) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "We could not verify your payment.");
  }

  const user = await freshUser(request.user);
  const now = new Date();
  const current = user.get("planExpiresAt");
  const from = (user.get("plan") === plan && current && current > now) ? current : now;
  const expires = new Date(from.getTime() + 30 * 24 * 3600 * 1000);
  const sameActive = user.get("plan") === plan && current && current > now;
  user.set("planStartedAt", sameActive ? (user.get("planStartedAt") || now) : now);
  user.set("plan", plan);
  user.set("planExpiresAt", expires);
  await user.save(null, { useMasterKey: true });

  const pay = new Parse.Object("PlanPayment");
  pay.set("transactionId", String(transactionId)); pay.set("owner", user); pay.set("plan", plan); pay.set("amountXof", Number(tx.amount));
  const acl = new Parse.ACL(); acl.setPublicReadAccess(false); acl.setPublicWriteAccess(false);
  pay.setACL(acl);
  await pay.save(null, { useMasterKey: true });
  return { plan, expiresAt: expires };
});
