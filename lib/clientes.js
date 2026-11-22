// Analista de Marca — cadastro de clientes
// Guarda o perfil (nome + senha protegida) e o manual de marca de cada cliente
// no Vercel Blob, num armazenamento PRIVADO (os arquivos não têm link público).
// A senha nunca é guardada: guardamos apenas um "hash" (scrypt) com sal aleatório.

const crypto = require('crypto');
const { put, get } = require('@vercel/blob');

const LIMITE_PDF = 3 * 1048576;   // 3 MB
const LIMITE_TEXTO = 60000;       // caracteres

class ErroCliente extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// "Café Aurora Ltda." -> "cafe-aurora-ltda"
function gerarCodigo(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

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

async function lerPerfil(codigo) {
  const buf = await lerBlob(`clientes/${codigo}/perfil.json`);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}

function validarManual(manual) {
  if (!manual) throw new ErroCliente(400, 'Envie o manual de marca do cliente.');
  if (manual.tipo === 'pdf' && manual.data) {
    const buf = Buffer.from(String(manual.data), 'base64');
    if (buf.length > LIMITE_PDF) throw new ErroCliente(400, 'O PDF do manual passa de 3 MB.');
    if (buf.subarray(0, 4).toString() !== '%PDF') throw new ErroCliente(400, 'O arquivo enviado não parece ser um PDF.');
    return { tipo: 'pdf', conteudo: buf, nomeArquivo: String(manual.nomeArquivo || 'manual.pdf').slice(0, 120) };
  }
  if (manual.tipo === 'texto' && manual.texto) {
    const texto = String(manual.texto).trim().slice(0, LIMITE_TEXTO);
    if (texto.length < 40) throw new ErroCliente(400, 'Cole as regras do manual (pelo menos algumas linhas).');
    return { tipo: 'texto', conteudo: texto, nomeArquivo: 'regras coladas como texto' };
  }
  throw new ErroCliente(400, 'Manual de marca inválido.');
}

async function gravarManual(codigo, manual, perfil) {
  const caminho = `clientes/${codigo}/manual.${manual.tipo === 'pdf' ? 'pdf' : 'md'}`;
  await put(caminho, manual.conteudo, {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: manual.tipo === 'pdf' ? 'application/pdf' : 'text/markdown; charset=utf-8'
  });
  perfil.manual = { tipo: manual.tipo, caminho, nomeArquivo: manual.nomeArquivo, atualizadoEm: new Date().toISOString() };
  await put(`clientes/${codigo}/perfil.json`, JSON.stringify(perfil), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

function resumoPublico(perfil) {
  return { nome: perfil.nome, codigo: perfil.codigo, manual: { tipo: perfil.manual.tipo, nomeArquivo: perfil.manual.nomeArquivo, atualizadoEm: perfil.manual.atualizadoEm } };
}

async function cadastrar({ nome, senha, manual }) {
  verificarArmazenamento();
  nome = String(nome || '').trim().slice(0, 80);
  const codigo = gerarCodigo(nome);
  if (codigo.length < 2) throw new ErroCliente(400, 'Informe o nome do cliente.');
  if (String(senha || '').length < 6) throw new ErroCliente(400, 'A senha precisa ter pelo menos 6 caracteres.');
  if (await lerPerfil(codigo)) throw new ErroCliente(409, 'Já existe um cliente com esse nome. Use "Entrar" ou escolha outro nome.');
  const m = validarManual(manual);
  const perfil = { nome, codigo, ...protegerSenha(senha), criadoEm: new Date().toISOString() };
  await gravarManual(codigo, m, perfil);
  return resumoPublico(perfil);
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

async function atualizarManual({ nome, senha, manual }) {
  const perfil = await autenticar(nome, senha);
  await gravarManual(perfil.codigo, validarManual(manual), perfil);
  return resumoPublico(perfil);
}

// Usado pela análise: devolve o manual do cliente no formato que a IA recebe.
async function carregarManual(nome, senha) {
  const perfil = await autenticar(nome, senha);
  const buf = await lerBlob(perfil.manual.caminho);
  if (!buf) throw new ErroCliente(404, 'O manual deste cliente não foi encontrado. Envie o manual novamente.');
  return perfil.manual.tipo === 'pdf'
    ? { tipo: 'pdf', data: buf.toString('base64'), nome: perfil.nome }
    : { tipo: 'texto', texto: buf.toString('utf8'), nome: perfil.nome };
}

module.exports = { cadastrar, autenticar, atualizarManual, carregarManual, resumoPublico, ErroCliente };
