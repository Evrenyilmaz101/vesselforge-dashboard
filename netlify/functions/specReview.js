// Netlify Function: Spec Review with Claude (Anthropic)
// Endpoint: /.netlify/functions/specReview
// Requires env var: ANTHROPIC_API_KEY
// Optional dependencies (auto-bundled by Netlify): @anthropic-ai/sdk, pdf-parse, mammoth

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20240620';

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 501,
        body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server' }),
      };
    }

    const { tenderId, files = [], model } = JSON.parse(event.body || '{}');
    if (!tenderId || !Array.isArray(files) || files.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tenderId and files[] required' }) };
    }

    // Fetch and extract text from supported files (PDF/DOCX/TXT/MD/CSV/JSON/Code)
    const docs = [];
    for (const f of files) {
      try {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`fetch ${f.name} -> ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        let text = '';

        if (contentType.includes('pdf') || f.name.toLowerCase().endsWith('.pdf')) {
          // Lazy import to reduce cold start
          const pdfParse = (await import('pdf-parse')).default;
          const out = await pdfParse(buffer);
          text = out.text || '';
        } else if (contentType.includes('officedocument.wordprocessingml') || f.name.toLowerCase().endsWith('.docx')) {
          const mammoth = await import('mammoth');
          const out = await mammoth.extractRawText({ buffer });
          text = out.value || '';
        } else if (contentType.startsWith('text/') || /\.(txt|md|csv|json|yaml|yml|xml|ini|cfg|py|js|ts|java|cs|cpp|c|go|rb|rs)$/i.test(f.name)) {
          text = buffer.toString('utf8');
        } else {
          // Unknown type; store a stub but continue
          text = `Unsupported file type for ${f.name}. Content-type: ${contentType}`;
        }

        // Truncate very large docs to keep token cost reasonable
        const maxChars = 150_000;
        if (text.length > maxChars) text = text.slice(0, maxChars);

        docs.push({ name: f.name, text });
      } catch (err) {
        docs.push({ name: f.name, text: `Failed to load ${f.name}: ${err.message}` });
      }
    }

    // Build prompt for Claude
    const combined = docs.map(d => `FILE: ${d.name}\n${d.text}`).join('\n\n---\n\n');
    const system = `You are an expert mechanical/process engineering spec reviewer for pressure vessels and related equipment. Extract critical requirements and risks from client specifications. Return strict JSON only.`;
    const user = `From the following documents, extract a prioritized list of requirements and checks that impact design, materials, code compliance, testing/inspection, documentation, and delivery. For each item, return:\n- id: string (stable)\n- severity: High | Medium | Low\n- category: Design | Materials | Fabrication | Testing | Documentation | Delivery | Safety | Code\n- requirement: concise requirement statement\n- rationale: why this matters / downstream impact\n- source: { fileName: string, page?: number } (best effort)\n\nOnly output JSON array. Documents:\n\n${combined}`;

    // Call Anthropic
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });
    let completion;
    try {
      completion = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 1400,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      });
    } catch (e) {
      console.error('Anthropic API error', e?.response?.data || e.message);
      return { statusCode: 502, body: JSON.stringify({ error: 'Claude API error', details: e.message }) };
    }

    // Extract text from blocks
    const textBlocks = (completion.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    let results = [];
    try {
      // Attempt strict JSON parse; fallback to bracket extraction
      results = JSON.parse(textBlocks);
    } catch {
      const start = textBlocks.indexOf('[');
      const end = textBlocks.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        results = JSON.parse(textBlocks.slice(start, end + 1));
      } else {
        results = [];
      }
    }

    // Basic normalization
    results = (Array.isArray(results) ? results : []).map((r, i) => ({
      id: String(r.id || i + 1),
      severity: r.severity || 'Medium',
      category: r.category || 'Design',
      requirement: r.requirement || '',
      rationale: r.rationale || '',
      source: r.source || null,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenderId, results }),
    };
  } catch (error) {
    console.error('specReview error', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};


