// Netlify Function: Spec Review with Claude (Anthropic)
// Endpoint: /.netlify/functions/specReview
// Requires env var: ANTHROPIC_API_KEY
// Optional dependencies (auto-bundled by Netlify): @anthropic-ai/sdk, pdf-parse, mammoth

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20240620';

exports.handler = async (event) => {
  console.log('🔍 SpecReview function started');
  
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    console.log('🔑 Checking API key...');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('❌ API key not found');
      return {
        statusCode: 501,
        body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server' }),
      };
    }
    console.log('✅ API key found');

    console.log('📥 Parsing request body...');
    const { tenderId, files = [], model } = JSON.parse(event.body || '{}');
    console.log(`📄 Request: ${tenderId}, ${files.length} files`);
    
    if (!tenderId || !Array.isArray(files) || files.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tenderId and files[] required' }) };
    }

    // OPTIMIZED CLAUDE INTEGRATION - Fast & focused engineering review
    console.log('⚡ Starting optimized Claude spec review...');
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

    // OPTIMIZED CLAUDE INTEGRATION - Fast engineering review
    console.log('🤖 Initializing Claude API...');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });
    console.log('✅ Claude API initialized');
    
    // Fast, focused engineering review approach
    let results = [];
    console.log(`📊 Processing ${docs.length} documents...`);
    
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
    
    // Smart chunking for very large documents (>25k chars) to prevent timeouts
    if (text.length > 25000) {
      diagnostics.push(`Large document detected (${text.length} chars) - using smart chunking`);
      
      const chunkSize = 20000;
      const overlap = 1000;
      const chunks = [];
      
      for (let i = 0; i < text.length; i += chunkSize - overlap) {
        const chunk = text.slice(i, i + chunkSize);
        const chunkNum = Math.floor(i / (chunkSize - overlap)) + 1;
        const totalChunks = Math.ceil(text.length / (chunkSize - overlap));
        chunks.push({ text: chunk, chunkNum, totalChunks });
      }
      
      diagnostics.push(`Split into ${chunks.length} chunks for comprehensive analysis`);
      
      // Process each chunk and combine results
      for (const { text: chunkText, chunkNum, totalChunks } of chunks) {
        try {
          const chunkPrompt = `You are a senior design engineer and certified welding engineer. This is chunk ${chunkNum} of ${totalChunks} from specification: ${doc.name}

ANALYZE THIS SECTION COMPREHENSIVELY:
${chunkText}

Extract ALL technical requirements from this section. Include every specification, tolerance, procedure, and requirement found. Return 10-20 detailed requirements from this section only.

[Same JSON format and engineering analysis requirements as main prompt...]

Return JSON array with detailed requirements from this section.`;

          const chunkCompletion = await anthropic.messages.create({
            model: model || DEFAULT_MODEL,
            max_tokens: 3000,
            temperature: 0,
            system: 'Extract ALL requirements from this document section. Be comprehensive and detailed.',
            messages: [{ role: 'user', content: chunkPrompt }],
          });
          
          const chunkResponse = (chunkCompletion.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          let chunkResults = [];
          
          try {
            chunkResults = JSON.parse(chunkResponse);
          } catch {
            const start = chunkResponse.indexOf('[');
            const end = chunkResponse.lastIndexOf(']');
            if (start !== -1 && end !== -1) {
              chunkResults = JSON.parse(chunkResponse.slice(start, end + 1));
            }
          }
          
          if (Array.isArray(chunkResults)) {
            results.push(...chunkResults);
            diagnostics.push(`Chunk ${chunkNum}/${totalChunks}: ${chunkResults.length} requirements extracted`);
          }
          
        } catch (chunkError) {
          diagnostics.push(`Chunk ${chunkNum} failed: ${chunkError.message}`);
        }
      }
      
    } else {
      // Single document analysis for smaller documents
      try {
      const prompt = `You are a senior design engineer and certified welding engineer with 20+ years of experience in pressure vessel design, fabrication, and ASME code compliance. Perform a COMPREHENSIVE, DETAILED engineering review of the ENTIRE specification document.

SPECIFICATION DOCUMENT TO ANALYZE:
${text}

COMPREHENSIVE ENGINEERING REVIEW REQUIREMENTS:
Read through EVERY section, paragraph, table, drawing note, and specification detail in this document. As an experienced design and welding engineer, extract ALL technical requirements, not just highlights.

🔧 DESIGN ENGINEERING ANALYSIS:
- ALL operating conditions (pressure, temperature, flow, cycles, environment)
- COMPLETE material specifications, grades, properties, certifications
- ALL dimensional requirements, tolerances, and geometric specifications
- FULL structural design criteria, stress analysis, fatigue requirements
- ALL safety factors, design margins, and safety systems
- COMPLETE nozzle, opening, and reinforcement requirements
- ALL support, foundation, and mounting specifications

⚡ WELDING ENGINEERING ANALYSIS:
- ALL welding procedures, qualifications, and consumables
- COMPLETE joint designs, configurations, and efficiency factors
- ALL heat treatment requirements (preheat, interpass, PWHT)
- COMPREHENSIVE NDE requirements (RT, UT, MT, PT, VT)
- ALL material compatibility and weldability requirements
- COMPLETE welding quality and acceptance standards
- ALL repair and rework procedures

📋 CODE & COMPLIANCE ANALYSIS:
- ALL ASME Section VIII Division 1/2 requirements
- COMPLETE API, ASTM, AWS standards referenced
- ALL third-party inspection and witness points
- COMPREHENSIVE documentation and certification requirements
- ALL local jurisdiction and special requirements

🔍 FABRICATION & QUALITY ANALYSIS:
- ALL fabrication procedures and sequences
- COMPLETE dimensional and geometric tolerances
- ALL surface finish and coating requirements
- COMPREHENSIVE testing procedures (hydrostatic, pneumatic, leak)
- ALL quality control and inspection plans

Return a JSON array with 40-60 detailed requirements in this format:
[
  {
    "id": "req_XXX",
    "category": "Design|Materials|Welding|Testing|Code|Safety|Fabrication|Quality",
    "requirement": "Detailed requirement with exact values, tolerances, procedures, and acceptance criteria",
    "rationale": "Detailed engineering explanation of why this requirement is critical for safety, performance, or compliance",
    "source": {"fileName": "${doc.name}", "section": "specific section where found"},
    "details": "Additional technical context, calculations, or related requirements"
  }
]

CRITICAL: This must be a COMPLETE engineering review. Extract requirements from:
- Main specification text and clauses
- All tables, charts, and data sheets
- Drawing notes and dimensional requirements
- Referenced standards and codes
- Material property tables and certificates
- Test procedures and acceptance criteria
- Quality plans and inspection requirements

Return 40-60 comprehensive requirements covering the ENTIRE document. Be thorough and detailed.`;

      const completion = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 4000, // Increased for comprehensive review
        temperature: 0,
        system: 'You are a senior design engineer and certified welding engineer. Perform a comprehensive review of the ENTIRE document. Extract ALL technical requirements from every section. Return only a valid JSON array with 40-60 detailed requirements.',
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
    } // Close the else block for single document analysis
    
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
    console.error('❌ SpecReview function error:', error);
    return { 
      statusCode: 500, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message || 'Unknown error',
        diagnostics: [`Function crashed: ${error.message}`]
      }) 
    };
  }
};


