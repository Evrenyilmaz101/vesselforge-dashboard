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
    const diagnostics = [];
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
          try {
            const pdfParse = (await import('pdf-parse')).default;
            const out = await pdfParse(buffer);
            text = out.text || '';
          } catch (e) {
            diagnostics.push(`PDF-PARSE: failed - ${e.message}`);
            text = '';
          }
          // OCR fallback for scanned/image PDFs
          if (!text || text.trim().length < 50) {
            // Preferred OCR: Azure Computer Vision Read API (reliable, large limits)
            const azureEndpoint = process.env.AZURE_CV_ENDPOINT;
            const azureKey = process.env.AZURE_CV_KEY;
            if (azureEndpoint && azureKey) {
              try {
                diagnostics.push(`AZURE: start for ${f.name} (${buffer.length} bytes)`);
                console.log('AZURE OCR: starting', { file: f.name, len: buffer.length });
                const analyzeUrl = `${azureEndpoint.replace(/\/$/, '')}/vision/v3.2/read/analyze`;
                // Send binary PDF
                const analyzeRes = await fetch(analyzeUrl, {
                  method: 'POST',
                  headers: {
                    'Ocp-Apim-Subscription-Key': azureKey,
                    'Content-Type': 'application/octet-stream'
                  },
                  body: buffer
                });
                if (!analyzeRes.ok) {
                  diagnostics.push(`AZURE: analyze HTTP ${analyzeRes.status}`);
                  throw new Error(`Azure analyze status ${analyzeRes.status}`);
                }
                const opLoc = analyzeRes.headers.get('operation-location');
                if (!opLoc) {
                  diagnostics.push('AZURE: operation-location header missing');
                  throw new Error('Azure operation-location header missing');
                }
                // Poll for result
                let ocrText = '';
                for (let i = 0; i < 30; i++) { // up to ~30s
                  await new Promise(r => setTimeout(r, 1000));
                  const rRes = await fetch(opLoc, { headers: { 'Ocp-Apim-Subscription-Key': azureKey } });
                  const rJson = await rRes.json();
                  const status = rJson.status || rJson.statusCode || rJson.analyzeResult?.status;
                  console.log('AZURE OCR: poll', { i, status });
                  if (i === 0) diagnostics.push(`AZURE: first poll status ${status}`);
                  if (status === 'succeeded') {
                    const lines = (rJson.analyzeResult?.readResults || rJson.analyzeResult?.pages || rJson.analyzeResult?.pages)?.flatMap(p => p.lines || []) || [];
                    if (lines.length > 0) {
                      ocrText = lines.map(l => l.text || '').join('\n');
                    } else if (rJson.analyzeResult?.content) {
                      ocrText = rJson.analyzeResult.content;
                    }
                    break;
                  }
                  if (status === 'failed') break;
                }
                if (ocrText && ocrText.trim().length > 50) {
                  text = ocrText;
                  diagnostics.push(`AZURE: success, ${text.length} chars`);
                  console.log('AZURE OCR: success', { chars: text.length });
                }
              } catch (azErr) {
                diagnostics.push(`AZURE: failed - ${azErr.message}`);
                console.warn('AZURE OCR: failed', f.name, azErr.message);
              }
            }
            const ocrKey = process.env.OCR_SPACE_API_KEY || 'helloworld';
            try {
              // First try remote URL mode
              const formUrl = new URLSearchParams();
              // Use base64 upload mode first to avoid remote URL fetch restrictions
              const b64 = `data:application/pdf;base64,${buffer.toString('base64')}`;
              formUrl.append('base64Image', b64);
              formUrl.append('filetype', 'PDF');
              formUrl.append('isCreateSearchablePdf', 'false');
              formUrl.append('isTable', 'false');
              formUrl.append('OCREngine', '2');
              let ocrRes = await fetch('https://api.ocr.space/parse/image', {
                method: 'POST',
                headers: { 'apikey': ocrKey, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formUrl.toString(),
              });
              let ocrJson = await ocrRes.json();
              let ocrText = (ocrJson?.ParsedResults || [])
                .map(r => r?.ParsedText || '')
                .join('\n');
              if (ocrText && ocrText.trim().length > 50) {
                text = ocrText;
                diagnostics.push(`OCR.SPACE: success, ${text.length} chars`);
                console.log('OCR.SPACE: success', { chars: text.length });
              }
            } catch (ocrErr) {
              diagnostics.push(`OCR.SPACE: failed - ${ocrErr.message}`);
              console.warn('OCR.SPACE: failed', f.name, ocrErr.message);
            }
          }
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
        if (!text || text.trim().length < 50) diagnostics.push(`EMPTY TEXT after all attempts for ${f.name}`);
      } catch (err) {
        diagnostics.push(`FETCH ERROR for ${f.name} - ${err.message}`);
        docs.push({ name: f.name, text: `Failed to load ${f.name}: ${err.message}` });
      }
    }

    // Smart chunking approach for large documents
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });
    
    const system = `You are a senior mechanical engineer and ASME code expert specializing in pressure vessel design, fabrication, and inspection. You must perform an exhaustive, line-by-line specification review extracting every single requirement, parameter, code reference, material property, dimensional tolerance, testing procedure, and compliance item. Be extremely detailed and thorough. Return strict JSON only.`;
    
    // Simplified approach - just send the FIRST document directly to Claude like you do
    let results = [];
    
    if (docs.length === 0) {
      diagnostics.push('No documents to analyze');
      return { statusCode: 400, body: JSON.stringify({ error: 'No documents provided', diagnostics }) };
    }
    
    // Take only the first document to avoid timeouts
    const doc = docs[0];
    const text = doc.text || '';
    
    if (!text || text.trim().length < 50) {
      diagnostics.push(`Document ${doc.name} has insufficient text content`);
      return { statusCode: 400, body: JSON.stringify({ error: 'Document has no readable text', diagnostics }) };
    }
    
    diagnostics.push(`Processing ${doc.name} - ${text.length} characters`);
    
    try {
      const prompt = `Extract ALL technical requirements from this specification document. Be thorough and systematic.

EXTRACT:
- Design parameters (pressure, temperature, dimensions, tolerances)
- Material specifications and properties  
- Code references (ASME, API, etc)
- Testing and inspection requirements
- Fabrication procedures and tolerances
- Documentation requirements
- Quality control procedures

${text}

Return JSON array:
[{
  "id": "req_1", 
  "category": "Design|Materials|Code|Testing|Fabrication|Documentation|Quality|Safety",
  "requirement": "specific requirement with values/tolerances",
  "rationale": "why this matters",
  "source": {"fileName": "${doc.name}"}
}]

Extract 30-50 key requirements. Focus on critical technical specifications. JSON only.`;

      const completion = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 2500,
        temperature: 0,
        system: 'You are a mechanical engineer. Extract technical requirements from specifications. Return valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
      });
      
      const response = (completion.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      
      try {
        results = JSON.parse(response);
      } catch {
        // Extract JSON array from response
        const start = response.indexOf('[');
        const end = response.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) {
          results = JSON.parse(response.slice(start, end + 1));
        } else {
          results = [];
        }
      }
      
      if (!Array.isArray(results)) {
        results = [];
      }
      
      diagnostics.push(`Successfully extracted ${results.length} requirements`);
      
    } catch (e) {
      console.error('Claude API error:', e);
      diagnostics.push(`Analysis failed: ${e.message}`);
      return { 
        statusCode: 502, 
        body: JSON.stringify({ 
          error: 'Analysis failed', 
          details: e.message,
          diagnostics 
        }) 
      };
    }
    
    // Deduplicate by requirement similarity
    const seen = new Set();
    results = results.filter(r => {
      const key = (r.requirement||'').trim().toLowerCase().slice(0, 100);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    diagnostics.push(`CLAUDE: final results - ${results.length} unique requirements`);

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
      body: JSON.stringify({ tenderId, results, diagnostics }),
    };
  } catch (error) {
    console.error('specReview error', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};


