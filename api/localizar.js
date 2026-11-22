// Analista de Marca — localiza o(s) logo(s) da marca numa imagem da peça.
// O navegador usa as coordenadas para recortar e ampliar o logo a partir da imagem
// original, em alta resolução. Assim a análise consegue comparar o desenho das letras.
// Recebe: { imagem: { mediaType, data }, largura, altura, marca? }
// Devolve: { logos: [ { x, y, largura, altura } ] } em pixels da imagem enviada.

const MODELO = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const FERRAMENTA = {
  name: 'marcar_logos',
  description: 'Registra a posição de cada logotipo/assinatura da marca encontrado na imagem.',
  input_schema: {
    type: 'object',
    properties: {
      logos: {
        type: 'array',
        description: 'Um item por logo encontrado (no máximo 2, o mais importante primeiro). Vazio se não houver logo.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'integer', description: 'Borda esquerda, em pixels.' },
            y: { type: 'integer', description: 'Borda de cima, em pixels.' },
            largura: { type: 'integer' },
            altura: { type: 'integer' }
          },
          required: ['x', 'y', 'largura', 'altura']
        }
      }
    },
    required: ['logos']
  }
};

// Modo "pagina": recebe miniaturas das páginas do manual e escolhe onde o logo principal
// aparece grande e isolado (a página de apresentação do logo).
const FERRAMENTA_PAGINAS = {
  name: 'escolher_paginas',
  description: 'Indica as páginas do manual em que o logotipo oficial aparece grande, inteiro e isolado.',
  input_schema: {
    type: 'object',
    properties: {
      paginas: {
        type: 'array',
        description: 'Até 2 números de página (os números escritos antes de cada miniatura), a melhor primeiro. Vazio se não houver.',
        items: { type: 'integer' }
      }
    },
    required: ['paginas']
  }
};

async function chamarClaude(chave, corpo) {
  const resposta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO, max_tokens: 4000, output_config: { effort: 'low' }, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, ...corpo })
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error((dados.error && dados.error.message) || 'Erro ao consultar a IA.');
  return dados;
}

async function escolherPaginas(req, res, chave) {
  const { paginas, marca } = req.body || {};
  if (!Array.isArray(paginas) || !paginas.length) return res.status(400).json({ erro: 'Envie as páginas do manual.' });
  const conteudo = [];
  paginas.slice(0, 80).forEach((p) => {
    conteudo.push({ type: 'text', text: `Página ${p.numero}:` });
    conteudo.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.data } });
  });
  conteudo.push({ type: 'text', text: `Estas são páginas do manual de marca${marca ? ` de "${String(marca).slice(0, 80)}"` : ''}. Indique a página em que a versão PRINCIPAL do logotipo aparece maior, inteira e isolada (sem outros elementos por cima), de preferência sobre fundo liso. Evite páginas de usos incorretos/proibidos, grids de construção com linhas por cima e mockups. Se houver uma segunda boa opção (por exemplo, a versão em negativo), indique também. Responda chamando a ferramenta escolher_paginas.` });
  const dados = await chamarClaude(chave, { tools: [FERRAMENTA_PAGINAS], messages: [{ role: 'user', content: conteudo }] });
  const bloco = (dados.content || []).find((b) => b.type === 'tool_use' && b.name === 'escolher_paginas');
  const validas = new Set(paginas.map((p) => p.numero));
  const escolhidas = ((bloco && bloco.input && bloco.input.paginas) || []).map(Number).filter((n) => validas.has(n)).slice(0, 2);
  return res.status(200).json({ paginas: escolhidas });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST.' });
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.status(500).json({ erro: 'A chave da API não foi configurada.' });
  try {
    if ((req.body || {}).modo === 'pagina') return await escolherPaginas(req, res, chave);
    const { imagem, largura, altura, marca } = req.body || {};
    const L = Number(largura), A = Number(altura);
    if (!imagem || !imagem.data || !L || !A) return res.status(400).json({ erro: 'Imagem inválida.' });

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        tools: [FERRAMENTA],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imagem.mediaType || 'image/jpeg', data: imagem.data } },
          { type: 'text', text: `Esta imagem tem ${L} × ${A} pixels. Encontre o logotipo (ou a assinatura com o nome) da marca${marca ? ` "${String(marca).slice(0, 80)}"` : ''} e informe a caixa que o envolve por completo, em pixels desta imagem (origem no canto superior esquerdo). Inclua todo o logo, sem cortar letras. Responda chamando a ferramenta marcar_logos.` }
        ] }]
      })
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) return res.status(502).json({ erro: (dados.error && dados.error.message) || 'Erro ao localizar o logo.' });

    const bloco = (dados.content || []).find((b) => b.type === 'tool_use' && b.name === 'marcar_logos');
    const logos = ((bloco && bloco.input && bloco.input.logos) || []).slice(0, 2)
      .map((c) => {
        const x = Math.max(0, Math.min(L - 1, Math.round(c.x)));
        const y = Math.max(0, Math.min(A - 1, Math.round(c.y)));
        return { x, y, largura: Math.max(1, Math.min(L - x, Math.round(c.largura))), altura: Math.max(1, Math.min(A - y, Math.round(c.altura))) };
      })
      .filter((c) => c.largura >= 4 && c.altura >= 4);
    return res.status(200).json({ logos });
  } catch (e) {
    return res.status(500).json({ erro: 'Erro interno: ' + e.message });
  }
};
