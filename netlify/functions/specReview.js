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

    const { tenderId, files = [], model, codeStandard, equipmentType } = JSON.parse(event.body || '{}');
    if (!tenderId || !Array.isArray(files) || files.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tenderId and files[] required' }) };
    }
    
    if (!codeStandard || !equipmentType) {
      return { statusCode: 400, body: JSON.stringify({ error: 'codeStandard and equipmentType required' }) };
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

    // Fetch relevant code documents from Firebase Storage
    const codeMapping = {
      australian: {
        pressure_vessel: ['AS1210_PressureVessels.pdf', 'AS4458_Welding.pdf', 'AS1548_Materials.pdf'],
        storage_tank: ['AS1210_PressureVessels.pdf', 'AS4458_Welding.pdf', 'AS1548_Materials.pdf'],
        heat_exchanger: ['AS1210_PressureVessels.pdf', 'AS4458_Welding.pdf', 'AS1548_Materials.pdf'],
        piping: ['AS4458_Welding.pdf', 'AS1548_Materials.pdf'],
        reactor: ['AS1210_PressureVessels.pdf', 'AS4458_Welding.pdf', 'AS1548_Materials.pdf']
      },
      american: {
        pressure_vessel: ['ASME_VIII_Div1.pdf', 'ASME_B31.3_Piping.pdf'],
        storage_tank: ['API_650_Storage.pdf', 'ASME_VIII_Div1.pdf'],
        heat_exchanger: ['ASME_VIII_Div1.pdf', 'ASME_B31.3_Piping.pdf'],
        piping: ['ASME_B31.3_Piping.pdf'],
        reactor: ['ASME_VIII_Div1.pdf', 'ASME_B31.3_Piping.pdf']
      },
      european: {
        pressure_vessel: ['EN_13445_PressureVessels.pdf', 'PED_Directive.pdf'],
        storage_tank: ['EN_13445_PressureVessels.pdf', 'PED_Directive.pdf'],
        heat_exchanger: ['EN_13445_PressureVessels.pdf', 'PED_Directive.pdf'],
        piping: ['EN_1090_Structural.pdf'],
        reactor: ['EN_13445_PressureVessels.pdf', 'PED_Directive.pdf']
      }
    };

    const requiredCodes = codeMapping[codeStandard]?.[equipmentType] || [];
    diagnostics.push(`CODE MAPPING: ${codeStandard} + ${equipmentType} -> ${requiredCodes.length} codes`);

    // Try to fetch code documents (if available)
    for (const codeFile of requiredCodes) {
      try {
        // This would require Firebase Admin SDK or direct storage access
        // For now, we'll include the code requirements in the prompt instead
        diagnostics.push(`CODE: Would fetch ${codeFile} from Firebase Storage`);
      } catch (err) {
        diagnostics.push(`CODE FETCH ERROR: ${codeFile} - ${err.message}`);
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
      // Build code-specific context
      const codeContext = {
        australian: {
          name: "Australian Standards",
          codes: "AS1210 (Pressure Vessels), AS4458 (Welding), AS1548 (Materials)",
          focus: "Australian Standards requirements for pressure equipment"
        },
        american: {
          name: "American Standards", 
          codes: "ASME Section VIII (Pressure Vessels), ASME B31.3 (Piping), API Standards",
          focus: "ASME and API requirements for pressure equipment"
        },
        european: {
          name: "European Standards",
          codes: "EN 13445 (Pressure Vessels), PED (Pressure Equipment Directive)",
          focus: "European standards and PED requirements"
        }
      };

      const equipmentContext = {
        pressure_vessel: "pressure vessel design, construction, and testing",
        storage_tank: "storage tank design, construction, and integrity",
        heat_exchanger: "heat exchanger design, thermal performance, and construction",
        piping: "piping system design, materials, and installation",
        reactor: "reactor vessel design, process safety, and construction"
      };

      const selectedCodeContext = codeContext[codeStandard];
      const selectedEquipmentContext = equipmentContext[equipmentType];

      const prompt = `You are a senior mechanical engineer performing a COMPREHENSIVE specification review for a ${selectedEquipmentContext} according to ${selectedCodeContext.name}.

EQUIPMENT TYPE: ${equipmentType.replace('_', ' ').toUpperCase()}
CODE STANDARD: ${selectedCodeContext.name} (${selectedCodeContext.codes})

DOCUMENT TO REVIEW:
${text}

FOCUS ON ${selectedCodeContext.focus.toUpperCase()} FOR THIS ${equipmentType.replace('_', ' ').toUpperCase()}.

MANDATORY COMPREHENSIVE REVIEW - Extract EVERYTHING from:

1. DESIGN REQUIREMENTS:
- Operating conditions (pressure, temperature, flow rates, cycles)
- Vessel dimensions, wall thickness, head types
- Nozzle sizes, locations, reinforcement requirements
- Internal components (trays, baffles, supports)
- Corrosion allowances, stress analysis requirements
- Fatigue analysis, seismic/wind load requirements
- Thermal expansion considerations

2. MATERIAL SPECIFICATIONS:
- Base material grades and specifications
- Welding consumables and procedures
- Bolting materials and grades
- Gasket and seal materials
- Coating and lining materials
- Material property requirements (yield, tensile, impact)
- Heat treatment requirements
- Material certifications (MTCs, PMI)

3. CODE COMPLIANCE & STANDARDS:
- ASME Section VIII Division 1/2 requirements
- ASME B31.3 piping requirements
- API standards (API 510, 570, 650, etc.)
- Local jurisdiction requirements
- Special code cases or exemptions
- Third-party inspection requirements
- Code stamping and certification

4. FABRICATION REQUIREMENTS:
- Welding procedure specifications (WPS)
- Welder qualifications (WQT)
- Joint efficiency factors
- Fit-up tolerances and procedures
- Heat treatment procedures (PWHT)
- Forming and machining requirements
- Assembly procedures and sequences

5. TESTING & INSPECTION:
- Hydrostatic test pressure and procedures
- Pneumatic test requirements
- Radiographic testing (RT) requirements
- Ultrasonic testing (UT) requirements
- Magnetic particle testing (MT)
- Liquid penetrant testing (PT)
- Visual inspection criteria
- Acceptance standards and reject criteria
- Hold points and witness points

6. DOCUMENTATION REQUIREMENTS:
- Mill test certificates (MTCs)
- Welding documentation packages
- NDE reports and certifications
- Hydrostatic test certificates
- Code compliance documentation
- Fabrication drawings and procedures
- Quality control records
- As-built documentation

7. QUALITY ASSURANCE:
- QC procedures and plans
- Inspection and test plans (ITPs)
- Non-conformance procedures
- Corrective action requirements
- Third-party inspection requirements
- Audit and surveillance requirements

8. DIMENSIONAL TOLERANCES:
- Fabrication tolerances
- Assembly tolerances
- Straightness and roundness requirements
- Surface finish requirements
- Dimensional inspection procedures

For EVERY requirement found, return this exact JSON structure:
{
  "id": "req_XXX",
  "category": "Design|Materials|Code|Testing|Fabrication|Documentation|Quality|Safety|Dimensional",
  "requirement": "Complete, specific requirement statement with exact values, tolerances, procedures, and acceptance criteria",
  "rationale": "Detailed technical explanation of why this requirement exists and its impact on safety, performance, or compliance",
  "source": {"fileName": "${doc.name}", "section": "specific section/paragraph where found"},
  "details": "Additional technical context, referenced standards, or related requirements",
  "compliance_ref": "Specific ASME/API/code section if referenced"
}

CRITICAL INSTRUCTIONS:
- Read EVERY paragraph, sentence, table entry, note, and specification detail
- Extract 50-100+ requirements minimum for a proper spec review
- Include exact numerical values, tolerances, pressures, temperatures
- Capture procedural requirements step-by-step
- Include all referenced standards and specifications
- Extract requirements from tables, charts, and drawing notes
- Be extremely thorough - this is a professional engineering review

Return only the JSON array with NO other text. Extract EVERYTHING.`;

      const completion = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 4000, // Increased for comprehensive review
        temperature: 0,
        system: 'You are a senior mechanical engineer performing a comprehensive specification review. You must extract EVERY technical requirement from the entire document. Return only a valid JSON array with 50-100+ requirements.',
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


