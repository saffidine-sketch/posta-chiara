// Piccolo server senza dipendenze: mostra la pagina e chiede a Claude di leggere la lettera.
// La chiave API resta qui sul computer, mai nella pagina.
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5-5";

const PROMPT = `Questa è una lettera (foto, PDF o testo) ricevuta da una persona anziana in Italia.
Leggila e spiegala in italiano molto semplice, con frasi brevi, senza parole difficili o burocratiche.
Rispondi SOLO con un oggetto JSON con queste quattro chiavi (testo breve, al massimo una o due frasi ciascuna):
- "chi": chi manda la lettera
- "cosa": cosa chiede o cosa comunica la lettera, e cosa deve fare la persona
- "quanto": quanto c'è da pagare (con importo in euro). Se non c'è nulla da pagare scrivi "Niente da pagare."
- "quando": entro quando bisogna fare qualcosa o pagare (data scritta per esteso). Se non c'è scadenza scrivi "Nessuna scadenza indicata."
Se un'informazione non si legge bene, scrivi "Non si legge bene, chiedi aiuto a un familiare."
Se il contenuto non è una lettera, scrivi in "cosa" che non si riesce a leggere e di provare con un'altra foto.`;

function send(res, code, body, type = "application/json") {
  const bin = Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": bin ? type : type + "; charset=utf-8" });
  res.end(bin || typeof body === "string" ? body : JSON.stringify(body));
}

// Estrae il testo da un .docx (è un file zip) senza librerie esterne.
function testoDocx(buf) {
  let fine = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (fine < 0) return "";
  let n = buf.readUInt16LE(fine + 10), pos = buf.readUInt32LE(fine + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(pos + 10), dim = buf.readUInt32LE(pos + 20);
    const ln = buf.readUInt16LE(pos + 28), le = buf.readUInt16LE(pos + 30), lc = buf.readUInt16LE(pos + 32);
    const off = buf.readUInt32LE(pos + 42), nomeF = buf.toString("utf8", pos + 46, pos + 46 + ln);
    pos += 46 + ln + le + lc;
    if (nomeF !== "word/document.xml") continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const dati = buf.subarray(start, start + dim);
    const xml = (metodo === 8 ? zlib.inflateRawSync(dati) : dati).toString("utf8");
    return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, " ").replace(/<w:br\/>/g, "\n")
      .replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
  }
  return "";
}

// --- Limite di letture al giorno per persona (per indirizzo di rete), salvato su file ---
const LIMITE_GIORNO = 5;
const FILE_LIMITI = path.join(__dirname, "limiti.json");
const oggi = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-GG, ora locale
let limiti = {};
try { limiti = JSON.parse(fs.readFileSync(FILE_LIMITI, "utf8")); } catch {}
function salvaLimiti() {
  const g = oggi();
  for (const k of Object.keys(limiti)) if (limiti[k].giorno !== g) delete limiti[k];
  try { fs.writeFileSync(FILE_LIMITI, JSON.stringify(limiti)); } catch {}
}
function prenota(chi) {
  const g = oggi();
  if (!limiti[chi] || limiti[chi].giorno !== g) limiti[chi] = { giorno: g, n: 0 };
  if (limiti[chi].n >= LIMITE_GIORNO) return false;
  limiti[chi].n++; salvaLimiti(); return true;
}
function restituisci(chi) {
  if (limiti[chi] && limiti[chi].n > 0) { limiti[chi].n--; salvaLimiti(); }
}

async function spiega(req, res) {
  if (!KEY) return send(res, 500, { errore: "Manca la chiave ANTHROPIC_API_KEY." });
  let raw = "";
  for await (const c of req) raw += c;
  let nome, dati;
  try { ({ nome, dati } = JSON.parse(raw)); } catch { return send(res, 400, { errore: "Richiesta non valida." }); }
  const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.+)$/s.exec(dati || "");
  if (!m) return send(res, 400, { errore: "File non valido." });
  const mime = m[1], buf = Buffer.from(m[2], "base64");
  nome = String(nome || "").toLowerCase();

  let blocco;
  if (mime.startsWith("image/")) {
    blocco = { type: "image", source: { type: "base64", media_type: mime, data: m[2] } };
  } else if (mime === "application/pdf" || nome.endsWith(".pdf")) {
    blocco = { type: "document", source: { type: "base64", media_type: "application/pdf", data: m[2] } };
  } else if (nome.endsWith(".docx")) {
    const t = testoDocx(buf);
    if (!t) return send(res, 400, { errore: "Non riesco a leggere questo documento Word. Prova a salvarlo come PDF." });
    blocco = { type: "text", text: "TESTO DELLA LETTERA:\n" + t };
  } else if (nome.endsWith(".doc")) {
    return send(res, 400, { errore: "Questo è un vecchio documento Word. Salvalo come .docx o PDF e riprova." });
  } else if (mime.startsWith("text/") || nome.endsWith(".txt")) {
    blocco = { type: "text", text: "TESTO DELLA LETTERA:\n" + buf.toString("utf8") };
  } else {
    return send(res, 400, { errore: "Questo tipo di file non va bene. Scegli una foto, un PDF, un Word o un file di testo." });
  }

  // Limite giornaliero: lo conta il server, la pagina non può aggirarlo.
  const chi = req.socket.remoteAddress || "sconosciuto";
  if (!prenota(chi)) {
    return send(res, 429, { errore: `Hai usato le tue ${LIMITE_GIORNO} letture di oggi. Torna domani, ti aspetto!` });
  }

  let r, data;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        messages: [{ role: "user", content: [ blocco, { type: "text", text: PROMPT } ] }],
      }),
    });
    data = await r.json();
  } catch (e) { restituisci(chi); throw e; }
  // Se il servizio sbaglia, la lettura non viene contata.
  if (!r.ok) { restituisci(chi); return send(res, 502, { errore: data.error?.message || "Errore del servizio." }); }
  const testo = data.content?.find((b) => b.type === "text")?.text || "";
  const j = /\{[\s\S]*\}/.exec(testo);
  try { send(res, 200, JSON.parse(j[0])); }
  catch { send(res, 502, { errore: "Risposta non comprensibile." }); }
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/spiega") {
    return spiega(req, res).catch((e) => send(res, 500, { errore: String(e.message || e) }));
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html");
  }
  if (req.method === "GET" && req.url === "/scena3.jpg") {
    return send(res, 200, fs.readFileSync(path.join(__dirname, "scena3.jpg")), "image/jpeg");
  }
  send(res, 404, "Non trovato", "text/plain");
}).listen(PORT, "127.0.0.1", () => console.log(`Apri http://localhost:${PORT}`));
