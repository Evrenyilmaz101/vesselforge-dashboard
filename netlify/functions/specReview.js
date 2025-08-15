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
      const prompt = `PERFORM A COMPREHENSIVE, LINE-BY-LINE SPECIFICATION REVIEW. You must extract EVERY single requirement, parameter, tolerance, procedure, standard, and compliance item from this document. Read through the ENTIRE document systematically and capture ALL technical details.

MANDATORY REVIEW AREAS - Extract EVERYTHING you find:

1. DESIGN PARAMETERS: Operating pressure, temperature, flow rates, dimensions, wall thickness, corrosion allowance, stress limits, fatigue requirements, seismic design, wind loads, foundation requirements, piping connections, nozzle details, support configurations

2. MATERIALS: Exact material grades, chemical composition limits, mechanical properties, impact test temperatures, heat treatment requirements, material certificates (MTCs), traceability, welding consumables, bolting materials, gasket specifications

3. CODES & STANDARDS: ASME Section VIII Div 1/2, ASME B31.3, API standards, AWS welding codes, ASTM material specs, local regulations, exemptions, special design cases, code edition years

4. FABRICATION: Welding procedures (WPS), welder qualifications, joint designs, weld profiles, fit-up tolerances, heat treatment procedures, forming methods, machining requirements, assembly sequences

5. TESTING & INSPECTION: Hydrostatic test pressure and duration, pneumatic test requirements, radiographic testing (RT) requirements and acceptance, ultrasonic testing (UT), magnetic particle testing (MT), liquid penetrant testing (PT), visual inspection criteria, hardness testing, impact testing, dimensional inspection

6. QUALITY ASSURANCE: Quality control procedures, hold points, witness points, third-party inspection requirements, NDE procedures, calibration requirements, documentation requirements

7. DOCUMENTATION: Material test certificates, welding records, NDE reports, test certificates, data reports, nameplates, drawings, operation manuals, spare parts lists

8. DELIVERY & INSTALLATION: Shipping requirements, preservation methods, storage requirements, installation procedures, commissioning requirements, training requirements

9. TOLERANCES: Manufacturing tolerances, assembly tolerances, straightness, roundness, surface finish, machining tolerances, welding tolerances

10. OPERATIONAL REQUIREMENTS: Operating procedures, maintenance requirements, inspection schedules, safety procedures, emergency procedures

READ EVERY SECTION, TABLE, NOTE, APPENDIX, AND REFERENCE. Extract specific values, not generalities.

DOCUMENT: ${text}

Return a comprehensive JSON array with this exact structure:
[
  {
    "id": "unique_id",
    "category": "Design|Materials|Code|Fabrication|Testing|Documentation|Quality|Delivery|Safety|Operational",
    "requirement": "SPECIFIC requirement with exact values, tolerances, procedures",
    "rationale": "detailed explanation of why this requirement exists and its impact",
    "source": {"fileName": "${doc.name}", "section": "section if identifiable"},
    "details": "additional technical details, referenced standards, or related requirements",
    "compliance_ref": "specific code section, standard, or regulation if mentioned"
  }
]

BE EXHAUSTIVE. Extract 50-200+ requirements depending on document complexity. Include every specification detail, every tolerance, every test requirement, every material property, every procedure. This should be a COMPLETE engineering review.

Return ONLY the JSON array.`;

      const completion = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 4000,
        temperature: 0,
        system: 'You are a senior mechanical engineer and ASME code expert performing a comprehensive specification review. Extract EVERY requirement from the document. Be extremely thorough and detailed. Return only valid JSON.',
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


