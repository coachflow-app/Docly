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

// Construit les instructions données à l'IA selon l'action et le preset choisis dans le wizard
function buildInstructions(action, preset, fileType) {
  const base =
    "Tu es Docly, un assistant qui analyse des documents. " +
    "Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, sans ```.";

  const shapeByPreset = {
    court: "Réponds en un seul paragraphe très court (3 à 4 phrases maximum). Le champ 'content' est une chaîne de texte.",
    detaille: "Réponds en plusieurs paragraphes complets et détaillés, avec des sous-titres si utile. Le champ 'content' est une chaîne de texte (peut contenir des sauts de ligne).",
    professionnel: "Réponds dans un ton professionnel et formel, prêt à être partagé tel quel. Le champ 'content' est une chaîne de texte.",
    tableau: "Réponds avec un tableau de données structuré. Le champ 'content' doit être un objet {\"headers\": [\"...\"], \"rows\": [[\"...\"], [\"...\"]]}.",
    presentation: "Réponds sous forme de diapositives (5 à 8 slides). Le champ 'content' doit être un tableau de slides, chaque slide étant {\"title\": \"...\", \"bullets\": [\"...\"]}.",
    quiz: "Génère un quiz de 5 questions à choix multiples basées sur le document. Le champ 'content' doit être un tableau de {\"question\": \"...\", \"options\": [\"...\"], \"correctIndex\": 0}.",
    flashcards: "Génère 8 flashcards basées sur le document. Le champ 'content' doit être un tableau de {\"front\": \"...\", \"back\": \"...\"}.",
    "fiche-revision": "Réponds sous forme de fiche de révision structurée (titres, définitions, points clés). Le champ 'content' est une chaîne de texte en markdown simple.",
    rapport: "Réponds sous forme de rapport professionnel structuré (introduction, sections, conclusion). Le champ 'content' est une chaîne de texte en markdown simple."
  };

  const actionByType = {
    summarize: "Résume fidèlement le document fourni.",
    analyze: "Analyse le contenu du document afin d'en faire ressortir les informations pertinentes : thèmes principaux, structure, points saillants.",
    ask: "Réponds à la question posée par l'utilisateur en te basant STRICTEMENT sur le contenu du document. Le champ 'content' est une chaîne de texte.",
    "key-points": "Extrait uniquement les points clés du document, sous forme de liste (5 à 10 points). Le champ 'content' doit être un tableau de chaînes.",
    "action-items": "Identifie les actions ou prochaines étapes présentes dans le document. Le champ 'content' doit être un tableau de chaînes.",
    extract: "Recherche et extrait les informations demandées dans le document (données, chiffres, clauses...). Le champ 'content' doit être un tableau de {\"label\": \"nom de l'information\", \"value\": \"valeur trouvée\"}.",
    transform: "Transforme le contenu du document selon le format demandé."
  };

  const actionInstruction = actionByType[action] || "Traite le document selon la demande de l'utilisateur.";
  const citationRule = citationInstructions(fileType);

  // key-points, action-items et extract imposent déjà leur propre forme :
  // ne pas ajouter l'instruction de forme du preset, qui la contredirait.
  if (action === "key-points" || action === "action-items" || action === "extract") {
    return `${base}\n${actionInstruction}\n${citationRule}\n${INLINE_CITATION_RULE}`;
  }

  const shape = shapeByPreset[preset] || "Réponds sous forme de texte clair et bien structuré. Le champ 'content' est une chaîne de texte.";
  return `${base}\n${actionInstruction}\n${shape}\n${citationRule}\n${INLINE_CITATION_RULE}`;
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
    "Le champ 'content' doit être un objet {\"similarities\": [\"...\"], \"differences\": [\"...\"]}. " +
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
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Action manquante (summarize, analyze, ask, extract, key-points, action-items, transform, compare).");
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
      `{"content": {"similarities": ["..."], "differences": ["..."]}, "sources": [{"docName": "...", "page": 0, "paragraph": 0, "cell": "...", "note": "..."}]}`;
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
  const systemPrompt = buildInstructions(action, preset, fileType);
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
