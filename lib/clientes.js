// Analista de Marca — cadastro de clientes
// Guarda o perfil (nome + senha protegida) e o manual de marca de cada cliente
// no Vercel Blob, num armazenamento PRIVADO (os arquivos não têm link público).
// A senha nunca é guardada: guardamos apenas um "hash" (scrypt) com sal aleatório.
//
// Manuais em PDF (até 100 MB) vão direto do navegador para o Blob (api/upload.js).
// Depois, UMA única vez, a IA lê o PDF inteiro e escreve as regras da marca em texto.
// Esse texto fica salvo e é ele que as análises usam (mais rápido e mais barato).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { put, get, issueSignedToken, presignUrl } = require('@vercel/blob');

const LIMITE_PDF = 100 * 1048576; // 100 MB
const LIMITE_TEXTO = 60000;       // caracteres (regras coladas)
const MODELO = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1';

class ErroCliente extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// "Café Aurora Ltda." -> "cafe-aurora-ltda"  (a mesma regra existe no index.html)
function gerarCodigo(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
const caminhoPdfOriginal = (codigo) => `clientes/${codigo}/manual-original.pdf`;
const caminhoRegras = (codigo) => `clientes/${codigo}/manual.md`;
const caminhoPerfil = (codigo) => `clientes/${codigo}/perfil.json`;
const caminhoLogo = (codigo, n) => `clientes/${codigo}/logos/logo-${n}.jpg`;
const MAX_LOGOS = 4;

function protegerSenha(senha, sal) {
  sal = sal || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), sal, 32).toString('hex');
  return { sal, hash };
}

function senhaConfere(senha, perfil) {
  const { hash } = protegerSenha(senha, perfil.sal);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(perfil.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verificarArmazenamento() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new ErroCliente(500, 'O armazenamento de clientes (Vercel Blob) ainda não foi ligado a este projeto na Vercel.');
  }
}

async function lerBlob(caminho) {
  const r = await get(caminho, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

async function gravarBlob(caminho, conteudo, contentType) {
  await put(caminho, conteudo, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType });
}

async function lerPerfil(codigo) {
  const buf = await lerBlob(caminhoPerfil(codigo));
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}

function validarNovoCadastro(nome, senha) {
  nome = String(nome || '').trim().slice(0, 80);
  const codigo = gerarCodigo(nome);
  if (codigo.length < 2) throw new ErroCliente(400, 'Informe o nome do cliente.');
  if (String(senha || '').length < 6) throw new ErroCliente(400, 'A senha precisa ter pelo menos 6 caracteres.');
  return { nome, codigo };
}

async function autenticar(nome, senha) {
  verificarArmazenamento();
  const codigo = gerarCodigo(nome);
  const perfil = codigo ? await lerPerfil(codigo) : null;
  if (!perfil || !senhaConfere(senha || '', perfil)) {
    throw new ErroCliente(401, 'Cliente ou senha incorretos.');
  }
  return perfil;
}

// ---------- Upload direto do navegador: quem pode enviar o PDF? ----------
// Chamado por api/upload.js antes de liberar o envio. Só aceita o caminho do próprio cliente.
async function autorizarUpload(pathname, payloadTexto) {
  verificarArmazenamento();
  let payload = {};
  try { payload = JSON.parse(payloadTexto || '{}'); } catch (_) { /* ignora */ }
  let codigo;
  if (payload.acao === 'cadastrar') {
    codigo = validarNovoCadastro(payload.nome, payload.senha).codigo;
    if (await lerPerfil(codigo)) throw new ErroCliente(409, 'Já existe um cliente com esse nome. Use "Entrar" ou escolha outro nome.');
  } else if (payload.acao === 'atualizar') {
    codigo = (await autenticar(payload.nome, payload.senha)).codigo;
  } else {
    throw new ErroCliente(400, 'Envio não autorizado.');
  }
  if (pathname !== caminhoPdfOriginal(codigo)) throw new ErroCliente(400, 'Caminho de envio inválido.');
  return {
    allowedContentTypes: ['application/pdf'],
    maximumSizeInBytes: LIMITE_PDF,
    addRandomSuffix: false,
    allowOverwrite: true
  };
}

// ---------- Leitura do PDF pela IA (uma única vez) ----------
const INSTRUCOES_EXTRACAO = `Você é um analista sênior de branding. Leia o manual de marca anexado por completo e escreva, em português, um "manual resumido" com TODAS as regras verificáveis numa peça de comunicação. Esse texto vai substituir o PDF nas próximas análises, então não deixe de fora nenhuma regra relevante.

Use exatamente estas seções em Markdown (## título), nesta ordem:
1. Identificação da marca (nome, essência, posicionamento em 2 a 3 frases)
2. Logotipo (versões permitidas e quando usar cada uma; descrição visual detalhada do símbolo e da tipografia do logo; cores do logo; área de proteção; tamanho mínimo; fundos permitidos; usos proibidos)
3. Paleta de cores (cada cor com nome e todos os códigos que o manual trouxer: HEX, RGB, CMYK, Pantone; papel de cada cor e proporções de uso; combinações proibidas)
4. Tipografia (famílias, pesos, hierarquia de uso, alternativas, o que é proibido)
5. Layout e composição (grid, margens, alinhamentos, hierarquia, assinatura)
6. Imagem, fotografia, ilustração e ícones (estilo, tratamento, o que evitar)
7. Tom de voz e texto (personalidade, como escrever, exemplos do que fazer e do que não fazer, regras de emojis, CTAs, caixa alta)
8. Regras por canal ou formato (redes sociais, impresso, vídeo, digital etc.)
9. Checklist de proibições (lista objetiva de tudo que o manual proíbe)

Regras: copie valores exatamente como estão no manual (códigos de cor, medidas, nomes de fontes). Não invente nada; se o manual não definir algo, escreva "Não especificado no manual". Indique a página quando ajudar. Seja completo e objetivo, sem introdução nem conclusão fora das seções.`;

function cabecalhosAnthropic(extra) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new ErroCliente(500, 'A chave da API (ANTHROPIC_API_KEY) não foi configurada na Vercel.');
  return { 'x-api-key': chave, 'anthropic-version': '2023-06-01', ...(extra || {}) };
}

async function enviarArquivoParaIA(pdf, nomeArquivo) {
  const tentar = async (extra) => {
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), nomeArquivo || 'manual.pdf');
    const r = await fetch(`${API}/files`, { method: 'POST', headers: cabecalhosAnthropic(extra), body: form });
    return { r, dados: await r.json().catch(() => ({})) };
  };
  let { r, dados } = await tentar();
  if (!r.ok && r.status === 400) ({ r, dados } = await tentar({ 'anthropic-beta': 'files-api-2025-04-14' }));
  if (!r.ok) throw new ErroCliente(502, 'Não foi possível enviar o manual para a IA: ' + ((dados.error && dados.error.message) || r.status));
  return dados.id;
}

async function apagarArquivoDaIA(id) {
  try { await fetch(`${API}/files/${id}`, { method: 'DELETE', headers: cabecalhosAnthropic() }); } catch (_) { /* não é crítico */ }
}

async function extrairRegrasDoPdf(pdf, nomeArquivo) {
  const fileId = await enviarArquivoParaIA(pdf, nomeArquivo);
  try {
    const r = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: cabecalhosAnthropic({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'file', file_id: fileId }, title: nomeArquivo || 'Manual de marca' },
          { type: 'text', text: INSTRUCOES_EXTRACAO }
        ] }]
      })
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (dados.error && dados.error.message) || ('código ' + r.status);
      throw new ErroCliente(502, 'A IA não conseguiu ler o manual: ' + msg + '. Se o PDF tiver mais de 600 páginas, envie só as páginas principais.');
    }
    if (dados.stop_reason === 'refusal') throw new ErroCliente(502, 'A IA recusou ler este manual.');
    const texto = (dados.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (texto.length < 200) throw new ErroCliente(502, 'A IA não conseguiu extrair as regras do manual. Tente de novo.');
    return dados.stop_reason === 'max_tokens' ? texto + '\n\n(Resumo cortado por tamanho.)' : texto;
  } finally {
    await apagarArquivoDaIA(fileId);
  }
}

// ---------- Manual: PDF já enviado ao Blob, ou regras coladas ----------
async function prepararRegras(codigo, manual) {
  if (manual && manual.tipo === 'pdf-enviado') {
    const pdf = await lerBlob(caminhoPdfOriginal(codigo));
    if (!pdf) throw new ErroCliente(400, 'O PDF do manual não chegou ao armazenamento. Envie de novo.');
    if (pdf.subarray(0, 4).toString() !== '%PDF') throw new ErroCliente(400, 'O arquivo enviado não parece ser um PDF.');
    const nomeArquivo = String(manual.nomeArquivo || 'manual.pdf').slice(0, 120);
    const regras = await extrairRegrasDoPdf(pdf, nomeArquivo);
    return { regras, info: { origem: 'pdf', nomeArquivo, tamanho: pdf.length } };
  }
  if (manual && manual.tipo === 'texto' && manual.texto) {
    const regras = String(manual.texto).trim().slice(0, LIMITE_TEXTO);
    if (regras.length < 40) throw new ErroCliente(400, 'Cole as regras do manual (pelo menos algumas linhas).');
    return { regras, info: { origem: 'texto', nomeArquivo: 'regras coladas como texto' } };
  }
  throw new ErroCliente(400, 'Envie o manual de marca do cliente.');
}

async function salvarManual(perfil, { regras, info }) {
  await gravarBlob(caminhoRegras(perfil.codigo), regras, 'text/markdown; charset=utf-8');
  perfil.manual = { ...info, caminho: caminhoRegras(perfil.codigo), atualizadoEm: new Date().toISOString() };
  await gravarBlob(caminhoPerfil(perfil.codigo), JSON.stringify(perfil), 'application/json');
}

// ---------- Logos oficiais (referência visual para comparar o desenho do logo) ----------
// O navegador já envia cada logo como JPEG (até ~1000 px), sobre um fundo que deixa o logo visível.
function validarLogos(logos) {
  if (!Array.isArray(logos) || !logos.length) throw new ErroCliente(400, 'Envie pelo menos uma imagem do logo oficial.');
  if (logos.length > MAX_LOGOS) throw new ErroCliente(400, `Envie no máximo ${MAX_LOGOS} imagens de logo.`);
  return logos.map((l) => {
    const buf = Buffer.from(String((l && l.data) || ''), 'base64');
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!jpeg || buf.length > 2 * 1048576) throw new ErroCliente(400, 'Imagem de logo inválida.');
    return { conteudo: buf, nome: String((l && l.nome) || 'logo').slice(0, 120) };
  });
}

async function gravarLogos(perfil, logos) {
  const validos = validarLogos(logos);
  perfil.logos = [];
  for (let i = 0; i < validos.length; i++) {
    const caminho = caminhoLogo(perfil.codigo, i + 1);
    await gravarBlob(caminho, validos[i].conteudo, 'image/jpeg');
    perfil.logos.push({ caminho, nome: validos[i].nome });
  }
}

async function lerLogos(perfil) {
  const lista = [];
  for (const l of perfil.logos || []) {
    const buf = await lerBlob(l.caminho);
    if (buf) lista.push({ mediaType: 'image/jpeg', data: buf.toString('base64'), nome: l.nome });
  }
  return lista;
}

async function atualizarLogos({ nome, senha, logos }) {
  const perfil = await autenticar(nome, senha);
  await gravarLogos(perfil, logos);
  await gravarBlob(caminhoPerfil(perfil.codigo), JSON.stringify(perfil), 'application/json');
  return resumoPublico(perfil, null, await lerLogos(perfil));
}

function resumoPublico(perfil, regras, logos) {
  const m = perfil.manual || {};
  const r = { nome: perfil.nome, codigo: perfil.codigo, manual: { origem: m.origem, nomeArquivo: m.nomeArquivo, tamanho: m.tamanho, atualizadoEm: m.atualizadoEm } };
  if (regras) r.regras = regras;
  r.logos = (logos || []).map((l) => ({ nome: l.nome, data: l.data }));
  return r;
}

async function cadastrar({ nome, senha, manual, logos }) {
  verificarArmazenamento();
  const dados = validarNovoCadastro(nome, senha);
  if (await lerPerfil(dados.codigo)) throw new ErroCliente(409, 'Já existe um cliente com esse nome. Use "Entrar" ou escolha outro nome.');
  const conteudo = await prepararRegras(dados.codigo, manual);
  const perfil = { nome: dados.nome, codigo: dados.codigo, ...protegerSenha(senha), criadoEm: new Date().toISOString() };
  if (Array.isArray(logos) && logos.length) await gravarLogos(perfil, logos);
  await salvarManual(perfil, conteudo);
  return resumoPublico(perfil, conteudo.regras, await lerLogos(perfil));
}

// Link temporário (10 min) para o navegador baixar o PDF original do manual do cliente.
// Usado para extrair o logo oficial direto das páginas do manual.
async function linkDoManual(nome, senha) {
  const perfil = await autenticar(nome, senha);
  if (!perfil.manual || perfil.manual.origem !== 'pdf') {
    throw new ErroCliente(404, 'Este cliente não tem um manual em PDF salvo. Envie os logos manualmente.');
  }
  const pathname = caminhoPdfOriginal(perfil.codigo);
  const validUntil = Date.now() + 10 * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
  return { url: presignedUrl, nomeArquivo: perfil.manual.nomeArquivo };
}

// Antes de enviar o PDF: confere se o nome está livre (cadastro novo)
async function verificarDisponivel(nome, senha) {
  verificarArmazenamento();
  const { codigo } = validarNovoCadastro(nome, senha);
  if (await lerPerfil(codigo)) throw new ErroCliente(409, 'Já existe um cliente com esse nome. Use "Entrar" ou escolha outro nome.');
  return { codigo };
}

async function entrar(nome, senha) {
  const perfil = await autenticar(nome, senha);
  const buf = await lerBlob(perfil.manual.caminho);
  const ehPdfAntigo = perfil.manual.tipo === 'pdf'; // cadastro antigo: o arquivo salvo é o próprio PDF
  return resumoPublico(perfil, buf && !ehPdfAntigo ? buf.toString('utf8') : '', await lerLogos(perfil));
}

async function atualizarManual({ nome, senha, manual }) {
  const perfil = await autenticar(nome, senha);
  const conteudo = await prepararRegras(perfil.codigo, manual);
  await salvarManual(perfil, conteudo);
  return resumoPublico(perfil, conteudo.regras, await lerLogos(perfil));
}

// Usado pela análise: devolve as regras do cliente em texto e as imagens oficiais do logo.
async function carregarManual(nome, senha) {
  const perfil = await autenticar(nome, senha);
  const buf = await lerBlob(perfil.manual.caminho);
  if (!buf) throw new ErroCliente(404, 'O manual deste cliente não foi encontrado. Envie o manual novamente.');
  // Cadastros antigos (antes desta versão) guardavam o PDF pequeno direto
  const logos = await lerLogos(perfil);
  if (perfil.manual.tipo === 'pdf') return { tipo: 'pdf', data: buf.toString('base64'), nome: perfil.nome, logos };
  return { tipo: 'texto', texto: buf.toString('utf8'), nome: perfil.nome, logos };
}

module.exports = { linkDoManual, verificarDisponivel, atualizarLogos, cadastrar, entrar, atualizarManual, carregarManual, autorizarUpload, ErroCliente };
