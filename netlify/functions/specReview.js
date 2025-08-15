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
    
    let results = [];
    
    for (const doc of docs) {
      const text = doc.text || '';
      if (!text || text.trim().length < 50) continue;
      
      // Extremely aggressive chunking to prevent any timeouts
      const isLarge = text.length > 15000; // Tiny threshold - always chunk large docs
      diagnostics.push(`CLAUDE: ${doc.name} - ${text.length} chars - ${isLarge ? 'CHUNKED' : 'FULL'} analysis`);
      
      if (!isLarge) {
        // Small/medium docs - analyze in full
        try {
          const prompt = `Perform an EXHAUSTIVE, line-by-line specification review of: ${doc.name}

Extract EVERY requirement, specification, parameter, tolerance, procedure, and compliance item. Be extremely detailed and granular.

MANDATORY EXTRACTION AREAS:
1. DESIGN PARAMETERS: Operating pressure, temperature, flow rates, vessel dimensions, wall thickness, corrosion allowance, stress analysis requirements, fatigue analysis, seismic considerations
2. MATERIAL SPECIFICATIONS: Material grades, heat treatment requirements, chemical composition limits, mechanical property requirements, impact testing temperatures, material certifications (MTRs), traceability requirements
3. CODE COMPLIANCE: ASME Section VIII Div 1/2, ASME B31.3, API standards, local codes, exemptions, special requirements, code stamping requirements
4. FABRICATION REQUIREMENTS: Welding procedures (WPS), welder qualifications, joint efficiency, weld inspection requirements, fit-up tolerances, heat treatment procedures, forming requirements
5. TESTING & INSPECTION: Hydrostatic test pressure, pneumatic test requirements, radiographic testing (RT), ultrasonic testing (UT), magnetic particle testing (MT), liquid penetrant testing (PT), visual inspection criteria, acceptance standards
6. DOCUMENTATION: Mill test certificates, welding documentation, NDE reports, hydrostatic test certificates, code compliance certificates, fabrication drawings, quality plans
7. DELIVERY & LOGISTICS: Shipping requirements, preservation, marking, documentation packages, delivery schedules, installation requirements
8. QUALITY ASSURANCE: QC procedures, hold points, witness points, third-party inspection requirements, quality plans, non-conformance procedures
9. DIMENSIONAL TOLERANCES: Fabrication tolerances, assembly tolerances, straightness, roundness, dimensional inspection requirements
10. SURFACE FINISH: Surface preparation, coating requirements, surface roughness, cleanliness requirements

For each requirement found, return:
- id: string (unique identifier)
- severity: High | Medium | Low (High=safety/code/critical, Medium=quality/performance, Low=documentation/administrative)
- category: Design | Materials | Fabrication | Testing | Documentation | Delivery | Safety | Code | Quality | Dimensional
- requirement: very specific, detailed requirement statement with exact values, tolerances, procedures
- rationale: detailed explanation of why this requirement exists and its impact on safety, quality, or compliance
- source: { fileName: "${doc.name}", page?: number, section?: string, paragraph?: string }
- details: additional technical details, referenced standards, or related requirements
- compliance_ref: specific code section, standard, or regulation if mentioned

Be exhaustive - extract requirements from:
- Main text and specifications
- Tables and charts  
- Drawing notes and details
- Referenced standards
- Footnotes and appendices
- Material property tables
- Dimensional tolerances
- Test procedures
- Quality requirements

Only output JSON array.

Document:
${text}`;

          const completion = await anthropic.messages.create({
            model: model || DEFAULT_MODEL,
            max_tokens: 4000,
            temperature: 0,
            system,
            messages: [{ role: 'user', content: prompt }],
          });
          
          const response = (completion.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
          let parsed = [];
          try {
            parsed = JSON.parse(response);
          } catch {
            const s = response.indexOf('['), e = response.lastIndexOf(']');
            if (s!==-1 && e!==-1 && e>s) parsed = JSON.parse(response.slice(s,e+1));
          }
          results.push(...(Array.isArray(parsed) ? parsed : []));
          
        } catch (e) {
          diagnostics.push(`CLAUDE: ${doc.name} full analysis failed - ${e.message}`);
        }
        
      } else {
        // Large docs - extremely small chunks to prevent timeouts
        const chunkSize = 12000; // Very tiny chunks
        const overlap = 1000; // Very minimal overlap
        
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
          const chunk = text.slice(i, i + chunkSize);
          const chunkNum = Math.floor(i / (chunkSize - overlap)) + 1;
          const totalChunks = Math.ceil(text.length / (chunkSize - overlap));
          
          try {
            const prompt = `EXHAUSTIVE analysis of chunk ${chunkNum}/${totalChunks} from specification: ${doc.name}

Extract EVERY requirement, parameter, tolerance, procedure, and compliance item from this section. Be extremely detailed.

EXTRACT FROM THIS CHUNK:
- Design parameters with exact values and tolerances
- Material specifications and properties  
- Code references and compliance requirements
- Fabrication procedures and tolerances
- Testing and inspection requirements with acceptance criteria
- Documentation and certification requirements
- Quality assurance procedures
- Dimensional requirements and tolerances
- Surface finish and coating requirements
- Any referenced standards or procedures

For each requirement return:
- id: string (unique identifier)
- severity: High | Medium | Low (High=safety/code/critical, Medium=quality/performance, Low=documentation/administrative)  
- category: Design | Materials | Fabrication | Testing | Documentation | Delivery | Safety | Code | Quality | Dimensional
- requirement: very specific, detailed requirement with exact values, tolerances, procedures
- rationale: detailed explanation of why this requirement exists and its impact
- source: { fileName: "${doc.name}", page?: number, section?: string, paragraph?: string }
- details: additional technical details, referenced standards, or related requirements
- compliance_ref: specific code section, standard, or regulation if mentioned

Be exhaustive - examine every sentence, table entry, note, and specification detail.

Only output JSON array.

Text:
${chunk}`;

            const completion = await anthropic.messages.create({
              model: model || DEFAULT_MODEL,
              max_tokens: 3000,
              temperature: 0,
              system,
              messages: [{ role: 'user', content: prompt }],
            });
            
            const response = (completion.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
            let parsed = [];
            try {
              parsed = JSON.parse(response);
            } catch {
              const s = response.indexOf('['), e = response.lastIndexOf(']');
              if (s!==-1 && e!==-1 && e>s) parsed = JSON.parse(response.slice(s,e+1));
            }
            results.push(...(Array.isArray(parsed) ? parsed : []));
            
          } catch (e) {
            diagnostics.push(`CLAUDE: ${doc.name} chunk ${chunkNum}/${totalChunks} failed - ${e.message}`);
          }
        }
      }
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


