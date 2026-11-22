// Analista de Marca — cadastro e acesso de clientes
// POST { acao: 'verificar' | 'cadastrar' | 'entrar' | 'atualizar', nome, senha, manual? }
// O cadastro com PDF pode levar de 1 a 3 minutos: a IA lê o manual inteiro uma vez.

const clientes = require('../lib/clientes');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST.' });
  const { acao, nome, senha, manual } = req.body || {};
  try {
    if (acao === 'cadastrar') {
      return res.status(201).json({ cliente: await clientes.cadastrar({ nome, senha, manual }) });
    }
    if (acao === 'verificar') {
      return res.status(200).json(await clientes.verificarDisponivel(nome, senha));
    }
    if (acao === 'entrar') {
      return res.status(200).json({ cliente: await clientes.entrar(nome, senha) });
    }
    if (acao === 'atualizar') {
      return res.status(200).json({ cliente: await clientes.atualizarManual({ nome, senha, manual }) });
    }
    return res.status(400).json({ erro: 'Ação inválida.' });
  } catch (e) {
    if (e instanceof clientes.ErroCliente) return res.status(e.status).json({ erro: e.message });
    return res.status(500).json({ erro: 'Erro interno: ' + e.message });
  }
};
