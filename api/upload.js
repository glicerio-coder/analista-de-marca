// Analista de Marca — libera o envio do PDF do manual direto do navegador para o
// armazenamento (Vercel Blob). Assim o arquivo não passa pela função e pode ter até 100 MB.

const { handleUpload } = require('@vercel/blob/client');
const clientes = require('../lib/clientes');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST.' });
  try {
    const resultado = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: (pathname, clientPayload) => clientes.autorizarUpload(pathname, clientPayload)
    });
    return res.status(200).json(resultado);
  } catch (e) {
    const status = e instanceof clientes.ErroCliente ? e.status : 400;
    return res.status(status).json({ error: e.message, erro: e.message });
  }
};
