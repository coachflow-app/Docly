// cloud/main.js
// Docly — Cloud Code : génération réelle du contenu via l'API Groq
// La clé API est lue depuis une variable d'environnement Back4app (jamais écrite ici).

const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Construit les instructions données à l'IA selon l'action et le preset choisis dans le wizard
function buildInstructions(action, preset) {
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
    analyze: "Analyse le document fourni : thèmes principaux, structure, points saillants.",
    extract: "Extrait les informations, données ou chiffres les plus pertinents du document.",
    ask: "Réponds à la question posée par l'utilisateur en te basant STRICTEMENT sur le contenu du document. Le champ 'content' est une chaîne de texte.",
    "key-points": "Extrait uniquement les points clés du document, sous forme de liste (5 à 10 points). Le champ 'content' doit être un tableau de chaînes.",
    "action-items": "Identifie les actions ou prochaines étapes présentes dans le document. Le champ 'content' doit être un tableau de chaînes.",
    transform: "Transforme le contenu du document selon le format demandé."
  };

  const shape = shapeByPreset[preset] || "Réponds sous forme de texte clair et bien structuré. Le champ 'content' est une chaîne de texte.";
  const actionInstruction = actionByType[action] || "Traite le document selon la demande de l'utilisateur.";

  return `${base}\n${actionInstruction}\n${shape}`;
}

Parse.Cloud.define("generateDocumentResult", async (request) => {
  const { text, action, preset, fileName, language, question } = request.params;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Aucun texte extrait à analyser.");
  }
  if (!action) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Action manquante (summarize, analyze, ask, extract, key-points, action-items, transform).");
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "Clé Groq non configurée côté serveur (variable GROQ_API_KEY manquante).");
  }

  // Limite de sécurité pour rester sous la fenêtre de contexte du modèle
  const truncatedText = text.slice(0, 24000);

  const systemPrompt = buildInstructions(action, preset);
  const langInstruction = language ? `Réponds en ${language}.` : "Réponds en français.";
  const questionPart = question ? `\n\nQuestion de l'utilisateur : "${question}"` : "";

  const userPrompt =
    `Document : "${fileName || "document"}"\n${langInstruction}${questionPart}\n\n` +
    `Contenu du document :\n"""\n${truncatedText}\n"""\n\n` +
    `Réponds STRICTEMENT avec un objet JSON de cette forme :\n` +
    `{"content": <voir consignes ci-dessus>, "sources": [{"paragraph": <numéro de paragraphe approximatif>, "note": "<courte description de l'endroit source>"}]}`;

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

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA n'était pas un JSON valide.");
  }

  if (!parsed.content) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, "La réponse de l'IA ne contient pas de champ 'content'.");
  }

  return {
    content: parsed.content,
    sources: Array.isArray(parsed.sources) ? parsed.sources : []
  };
});
  
