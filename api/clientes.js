// Analista de Marca — cadastro e acesso de clientes
// POST { acao: 'cadastrar' | 'entrar' | 'atualizar', nome, senha, manual? }

const clientes = require('../lib/clientes');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST.' });
  const { acao, nome, senha, manual } = req.body || {};
  try {
    if (acao === 'cadastrar') {
      return res.status(201).json({ cliente: await clientes.cadastrar({ nome, senha, manual }) });
    }
    if (acao === 'entrar') {
      const perfil = await clientes.autenticar(nome, senha);
      return res.status(200).json({ cliente: clientes.resumoPublico(perfil) });
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
