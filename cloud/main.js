// cloud/main.js
// Docly — Cloud Code : génération réelle du contenu via l'API Groq
// La clé API est lue depuis une variable d'environnement Back4app (jamais écrite ici).

const GROQ_MODEL = "openai/gpt-oss-120b";
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

async function callGroq(apiKey, systemPrompt, userPrompt) {
  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      })
    });
  } catch (err) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Impossible de contacter Groq : " + err.message);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, `Erreur Groq (${response.status}) : ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Réponse Groq vide ou mal formée.");
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA n'était pas un JSON valide.");
  }
}

Parse.Cloud.define("generateDocumentResult", async (request) => {
  const { text, action, preset, fileName, fileType, language, question, documents } = request.params;

  if (!action) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Action manquante (summarize, analyze, ask, extract, action-items, transform, compare).");
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Clé Groq non configurée côté serveur (variable GROQ_API_KEY manquante).");
  }

  const langInstruction = language ? `Réponds en ${language}.` : "Réponds en français.";

  // ---- Comparaison de plusieurs documents ----
  if (action === "compare") {
    if (!Array.isArray(documents) || documents.length < 2) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Il faut au moins deux documents pour une comparaison.");
    }
    const systemPrompt = buildCompareInstructions(documents.map((d) => d.fileType));
    const docsBlock = documents
      .map((d, i) => `### Document ${i + 1} : "${d.fileName || "document " + (i + 1)}"\n"""\n${(d.text || "").slice(0, 12000)}\n"""`)
      .join("\n\n");
    const userPrompt =
      `${langInstruction}\n\n${docsBlock}\n\n` +
      `Réponds STRICTEMENT avec un objet JSON de cette forme :\n` +
      `{"content": "## Points communs\\n\\nparagraphes...\\n\\n## Différences\\n\\nparagraphes...", "sources": [{"docName": "...", "page": 0, "paragraph": 0, "cell": "...", "note": "..."}]}`;
    const parsed = await callGroq(apiKey, systemPrompt, userPrompt);
    if (!parsed.content) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA ne contient pas de champ 'content'.");
    }
    return { content: parsed.content, sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
  }

  // ---- Génération sur un seul document ----
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Aucun texte extrait à analyser.");
  }

  const truncatedText = text.slice(0, 24000);
  const mode = action === "ask" ? (question ? "chat" : (preset === "quiz" ? "qa" : "chat")) : "standard";
  const systemPrompt = buildInstructions(action, preset, fileType, mode);
  const questionPart = question ? `\n\nQuestion de l'utilisateur : "${question}"` : "";

  const userPrompt =
    `Document : "${fileName || "document"}"\n${langInstruction}${questionPart}\n\n` +
    `Contenu du document :\n"""\n${truncatedText}\n"""\n\n` +
    `Réponds STRICTEMENT avec un objet JSON de cette forme :\n` +
    `{"content": <voir consignes ci-dessus>, "sources": [{"page": <numéro de page réel>, "paragraph": <numéro approximatif>, "cell": "<uniquement pour un tableur>", "note": "<courte description>"}]}`;

  const parsed = await callGroq(apiKey, systemPrompt, userPrompt);
  if (!parsed.content) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA ne contient pas de champ 'content'.");
  }

  return {
    content: parsed.content,
    sources: Array.isArray(parsed.sources) ? parsed.sources : []
  };
});
