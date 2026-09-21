// api/chat.js — Vercel Function
import { getSession } from "../lib/session.js";

const PROVIDERS = [
  { id:"groq", label:"Groq", url:"https://api.groq.com/openai/v1/chat/completions", key:process.env.GROQ_API_KEY, model:"openai/gpt-oss-120b" },
  { id:"gemini", label:"Gemini", url:"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key:process.env.GEMINI_API_KEY, model:"gemini-2.5-flash" },
  { id:"mistral", label:"Mistral", url:"https://api.mistral.ai/v1/chat/completions", key:process.env.MISTRAL_API_KEY, model:"mistral-small-latest" },
  { id:"nvidia", label:"NVIDIA", url:"https://integrate.api.nvidia.com/v1/chat/completions", key:process.env.NVIDIA_API_KEY, model:"openai/gpt-oss-120b" },
  { id:"openrouter", label:"OpenRouter", url:"https://openrouter.ai/api/v1/chat/completions", key:process.env.OPENROUTER_API_KEY, model:"openai/gpt-oss-20b:free" },
];

const SYSTEM_PROMPT = `Kamu adalah BlackMamer AI.

PERSONALITY:
- Ngobrol seperti teman yang enak diajak bicara, bukan customer service.
- Kalau user pakai Indonesia/slang, balas Indonesia yang santai dan natural. Boleh memakai "lu/gue" jika konteksnya cocok.
- Jangan memaksakan slang di setiap kalimat. Tetap jelas dan hormat.
- Kalau user curhat, dengarkan dulu, validasi seperlunya, lalu bantu. Jangan langsung menggurui atau mengubah semua curhat menjadi daftar langkah.
- Kalau user minta solusi teknis, langsung bantu secara konkret.
- Jangan mengarang fakta, hasil tool, file, preview, atau kemampuan yang sebenarnya tidak tersedia.

CODING:
- Kalau diminta kode, berikan kode lengkap yang siap dipakai bila memungkinkan.
- Jangan memotong bagian penting dengan "...".
- Jelaskan perubahan secara singkat setelah kode.
- Pertahankan API, nama endpoint, struktur project, dan kontrak existing kecuali user memang meminta perubahan.

WEBSITE / UI ANTI-SLOP:
Saat membuat atau mengubah website/UI, ikuti prinsip anti-slop dari miqdadbadjuber/anti-slop: hasil harus terasa dirancang untuk kebutuhan produk, bukan template AI generik.
- Setiap dekorasi, gradient, glass, badge, animasi, atau card harus punya alasan UX yang jelas.
- Jangan membuat fake stats, fake testimonials, fake activity, fake notifications, fake dashboards, atau angka yang tidak berasal dari data.
- Jangan membuat tombol yang hanya terlihat hidup; setiap interactive element harus punya aksi atau tujuan nyata.
- Sediakan state yang relevan: loading, empty, error, disabled, success bila diperlukan.
- Prioritaskan hierarchy, spacing, readability, keyboard/focus, responsive behavior, dan touch targets.
- Hindari copy generik seperti "Revolutionize your workflow" tanpa konteks produk.
- Jangan menambahkan fitur hanya untuk memenuhi pola UI AI.
- Untuk website yang diminta user, hasilkan single-file HTML lengkap bila itu yang paling mudah dipreview oleh frontend.
- Jika menghasilkan website, gunakan fenced code block \`\`\`html ... \`\`\` agar BlackMamer AI dapat menampilkan preview dan source code berdampingan.
- Jangan mengklaim telah menjalankan atau menguji website jika memang belum dijalankan.

IMAGE:
- Jika tidak ada image-generation tool/provider yang tersedia, jangan berpura-pura sudah membuat gambar. Bantu dengan prompt atau konsep dan jelaskan keterbatasannya secara singkat.`;

const MAX_MESSAGES=20, MAX_CHARS=8000, MAX_ATTACHMENTS=8, MAX_ATTACHMENT_TEXT=12000, PROVIDER_TIMEOUT_MS=14000;
const hits=new Map(), WINDOW_MS=60000, MAX_PER_WINDOW=20;
function limited(ip){const now=Date.now();const recent=(hits.get(ip)||[]).filter(t=>now-t<WINDOW_MS);recent.push(now);hits.set(ip,recent);if(hits.size>5000)hits.clear();return recent.length>MAX_PER_WINDOW}
function cleanMessages(input){if(!Array.isArray(input))return null;const out=[];for(const m of input.slice(-MAX_MESSAGES)){if(!m||(m.role!=="user"&&m.role!=="assistant"))continue;if(typeof m.content!=="string"||!m.content.trim())continue;out.push({role:m.role,content:m.content.slice(0,MAX_CHARS)})}if(!out.length||out[out.length-1].role!=="user")return null;return out}
function cleanAttachments(input){if(!Array.isArray(input))return [];return input.slice(0,MAX_ATTACHMENTS).map(a=>({name:String(a?.name||"file").slice(0,180),type:String(a?.type||"application/octet-stream").slice(0,120),size:Number.isFinite(Number(a?.size))?Number(a.size):0,text:typeof a?.text==="string"?a.text.slice(0,MAX_ATTACHMENT_TEXT):""})).filter(a=>a.name)}

export default async function handler(req,res){
  if(req.method!=="POST")return res.status(405).json({error:"Metode tidak diizinkan."});
  if(!getSession(req))return res.status(401).json({error:"Sesi tidak valid. Silakan login lagi."});
  const ip=String(req.headers["x-forwarded-for"]||"unknown").split(",")[0].trim();
  if(limited(ip))return res.status(429).json({error:"Terlalu banyak pesan. Tunggu semenit lalu coba lagi."});
  const messages=cleanMessages(req.body?.messages);
  if(!messages)return res.status(400).json({error:"Pesan kosong atau formatnya salah."});
  const attachments=cleanAttachments(req.body?.attachments);
  const active=PROVIDERS.filter(p=>p.key);
  if(!active.length)return res.status(500).json({error:"Belum ada API key. Isi minimal satu key di Environment Variables Vercel."});
  const requestedAgent=String(req.body?.agent||"auto").toLowerCase();
  let queue=active,forcedOnly=false;
  if(requestedAgent!=="auto"){
    const forced=active.find(p=>p.id===requestedAgent);
    if(!forced)return res.status(400).json({error:`Agent "${requestedAgent}" tidak tersedia (key belum diisi atau nama salah).`});
    queue=[forced];forcedOnly=true;
  }

  const attachmentContext=attachments.length?`\n\nLAMPIRAN DARI USER (konteks lokal frontend):\n${attachments.map((a,i)=>`[${i+1}] ${a.name} — ${a.type} — ${a.size} bytes${a.text?`\nIsi teks:\n${a.text}`:"\nFile ini hanya memiliki metadata/nama; jangan mengaku sudah membaca isi binary/gambar."}`).join("\n\n")}`:"";
  const payload=[{role:"system",content:SYSTEM_PROMPT},...messages];
  if(attachmentContext)payload[payload.length-1]={...payload[payload.length-1],content:payload[payload.length-1].content+attachmentContext};
  const failures=[];
  for(const p of queue){
    try{
      const r=await fetch(p.url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${p.key}`},body:JSON.stringify({model:p.model,messages:payload,max_tokens:4096}),signal:AbortSignal.timeout(PROVIDER_TIMEOUT_MS)});
      if(!r.ok){failures.push(`${p.id}:${r.status}`);continue}
      const data=await r.json();const reply=data?.choices?.[0]?.message?.content;
      if(typeof reply!=="string"||!reply.trim()){failures.push(`${p.id}:kosong`);continue}
      return res.status(200).json({reply,provider:p.id});
    }catch(e){failures.push(`${p.id}:${e.name==="TimeoutError"?"timeout":"error"}`)}
  }
  console.error("Semua provider gagal:",failures.join(", "));
  return res.status(503).json({error:forcedOnly?"Agent yang lu pilih lagi bermasalah. Coba agent lain atau Auto.":"Semua model lagi penuh atau lambat. Coba kirim ulang sebentar lagi."});
}
