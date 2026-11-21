// Analista de Marca — função de análise (roda no servidor da Vercel)
// Recebe o manual de marca + a peça, envia para o modelo de IA (Claude) com a skill
// "analista-de-marca" e devolve um relatório estruturado em JSON.

const fs = require('fs');
const path = require('path');

const MODELO = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_IMAGENS = 8;

function lerArquivo(relativo) {
  return fs.readFileSync(path.join(process.cwd(), relativo), 'utf8');
}

// Ferramenta que a IA usa para entregar o relatório num formato estruturado (JSON).
// Os modelos Claude mais novos não aceitam "forçar" uma ferramenta (tool_choice tipo "tool"),
// então usamos tool_choice "auto" e a instrução do prompt pede que ela seja usada.
const FERRAMENTA_RELATORIO = {
  name: 'registrar_analise',
  description: 'Registra o relatório final de conformidade da peça com o manual de marca.',
  input_schema: {
    type: 'object',
    properties: {
      marca_identificada: { type: 'string', description: 'Nome da marca segundo o manual.' },
      tipo_de_peca: { type: 'string', description: 'Ex.: post de feed, story, anúncio impresso, quadros de vídeo.' },
      descricao_da_peca: { type: 'string', description: 'Descrição objetiva do que aparece na peça (2 a 4 frases).' },
      resumo: { type: 'string', description: 'Parecer geral em 2 a 4 frases.' },
      nota_geral: { type: 'integer', minimum: 0, maximum: 100 },
      veredito: { type: 'string', enum: ['Aprovada', 'Aprovada com ajustes', 'Reprovada'] },
      criterios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            peso: { type: 'integer' },
            nota: { type: 'integer', minimum: 0, maximum: 10 },
            status: { type: 'string', enum: ['conforme', 'parcial', 'não conforme', 'não avaliável'] },
            observacao: { type: 'string' }
          },
          required: ['nome', 'peso', 'nota', 'status', 'observacao']
        }
      },
      problemas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            gravidade: { type: 'string', enum: ['alta', 'média', 'baixa'] },
            onde: { type: 'string', description: 'Onde o problema aparece na peça.' },
            descricao: { type: 'string' },
            regra_do_manual: { type: 'string', description: 'Regra violada, citada do manual.' },
            como_corrigir: { type: 'string' }
          },
          required: ['gravidade', 'onde', 'descricao', 'regra_do_manual', 'como_corrigir']
        }
      },
      pontos_fortes: { type: 'array', items: { type: 'string' } },
      limitacoes: { type: 'string', description: 'O que não pôde ser avaliado e por quê.' }
    },
    required: ['marca_identificada', 'tipo_de_peca', 'descricao_da_peca', 'resumo', 'nota_geral',
      'veredito', 'criterios', 'problemas', 'pontos_fortes', 'limitacoes']
  }
};

function blocoImagem(img) {
  return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } };
}
function blocoPdf(data) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Use POST.' });
  }
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) {
    return res.status(500).json({ erro: 'A chave da API (ANTHROPIC_API_KEY) não foi configurada na Vercel.' });
  }

  try {
    const { manual, peca, contexto } = req.body || {};
    if (!manual || !peca) {
      return res.status(400).json({ erro: 'Envie o manual de marca e a peça.' });
    }

    const skill = lerArquivo('skills/analista-de-marca/SKILL.md');
    const conteudo = [];

    // 1) Manual de marca
    conteudo.push({ type: 'text', text: '# MANUAL DE MARCA (fonte da verdade)' });
    if (manual.tipo === 'exemplo') {
      conteudo.push({ type: 'text', text: lerArquivo('dados/manual-exemplo-aurora-cafe.md') });
    } else if (manual.tipo === 'texto' && manual.texto) {
      conteudo.push({ type: 'text', text: String(manual.texto).slice(0, 60000) });
    } else if (manual.tipo === 'pdf' && manual.data) {
      conteudo.push(blocoPdf(manual.data));
    } else {
      return res.status(400).json({ erro: 'Manual de marca inválido.' });
    }

    // 2) Peça
    conteudo.push({ type: 'text', text: '# PEÇA A SER ANALISADA' });
    let infoPeca = `Tipo de arquivo enviado: ${peca.tipo}.`;
    if (peca.tipo === 'video') {
      infoPeca += ` Estes são ${peca.imagens.length} quadros extraídos do vídeo, em ordem, nos segundos: ${(peca.tempos || []).join(', ')}. Duração total: ${peca.duracao || '?'} s. O áudio não foi enviado.`;
    }
    if (peca.largura && peca.altura) {
      infoPeca += ` Dimensões originais: ${peca.largura}×${peca.altura} px.`;
    }
    if (contexto && contexto.canal) infoPeca += ` Canal informado pelo usuário: ${contexto.canal}.`;
    if (contexto && contexto.observacoes) infoPeca += ` Observações do usuário: ${String(contexto.observacoes).slice(0, 1500)}`;
    conteudo.push({ type: 'text', text: infoPeca });

    if (peca.tipo === 'pdf' && peca.data) {
      conteudo.push(blocoPdf(peca.data));
    } else if (Array.isArray(peca.imagens) && peca.imagens.length) {
      peca.imagens.slice(0, MAX_IMAGENS).forEach((img, i) => {
        if (peca.imagens.length > 1) conteudo.push({ type: 'text', text: `Quadro ${i + 1}:` });
        conteudo.push(blocoImagem(img));
      });
    } else {
      return res.status(400).json({ erro: 'Peça inválida.' });
    }

    conteudo.push({
      type: 'text',
      text: 'Analise a peça seguindo rigorosamente a skill Analista de Marca. Ao terminar, chame a ferramenta registrar_analise uma única vez com o relatório completo. Não escreva o relatório em texto: ele deve ir somente na ferramenta.'
    });

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': chave,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 16000,
        system: skill,
        tools: [FERRAMENTA_RELATORIO],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: conteudo }]
      })
    });

    const dados = await resposta.json();
    if (!resposta.ok) {
      const msg = (dados && dados.error && dados.error.message) || 'Erro ao chamar a IA.';
      return res.status(502).json({ erro: msg });
    }

    if (dados.stop_reason === 'refusal') {
      return res.status(502).json({ erro: 'A IA recusou analisar este conteúdo. Tente com outra peça.' });
    }
    if (dados.stop_reason === 'max_tokens') {
      return res.status(502).json({ erro: 'A resposta da IA ficou longa demais e foi cortada. Tente novamente.' });
    }

    const bloco = (dados.content || []).find((b) => b.type === 'tool_use' && b.name === 'registrar_analise');
    if (!bloco) {
      return res.status(502).json({ erro: 'A IA não retornou o relatório no formato esperado. Tente novamente.' });
    }
    return res.status(200).json({ relatorio: bloco.input, modelo: MODELO });
  } catch (e) {
    return res.status(500).json({ erro: 'Erro interno: ' + e.message });
  }
};
