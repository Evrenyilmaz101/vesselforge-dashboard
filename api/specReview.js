// Vercel serverless function for spec review
module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenderId, files, test } = req.body;
  
  // Test endpoint to check configuration
  if (test) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return res.status(200).json({ 
      message: 'Test endpoint working',
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey ? apiKey.length : 0,
      diagnostics: ['Test mode - configuration check']
    });
  }
  
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const diagnostics = [];
  
  try {
    // Get API key from environment
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      diagnostics.push('ANTHROPIC_API_KEY not set on server');
      return res.status(500).json({ error: 'API key not configured', diagnostics });
    }
    diagnostics.push(`API key found, length: ${apiKey.length}`);

    // Process first file
    const file = files[0];
    diagnostics.push(`Processing file: ${file.name}`);
    diagnostics.push(`File URL: ${file.url}`);
    
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    let text = '';
    
    // Simple text extraction
    if (file.name.endsWith('.txt') || file.name.match(/\.(js|py|java|cpp|cs|html|css|json|xml|md)$/)) {
      text = new TextDecoder().decode(buffer);
    } else if (file.name.endsWith('.pdf')) {
      // PDF text extraction - try OCR fallback for scanned PDFs
      try {
        diagnostics.push(`PDF detected, attempting OCR extraction...`);
        
        // Try Azure Computer Vision Read API first
        const azureEndpoint = process.env.AZURE_CV_ENDPOINT;
        const azureKey = process.env.AZURE_CV_KEY;
        
        if (azureEndpoint && azureKey) {
          diagnostics.push(`Using Azure Computer Vision for PDF OCR...`);
          
          // Convert buffer to base64 for Azure
          const base64Data = Buffer.from(buffer).toString('base64');
          
          // Submit for analysis
          const analyzeResponse = await fetch(`${azureEndpoint}/vision/v3.2/read/analyze`, {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': azureKey,
              'Content-Type': 'application/octet-stream'
            },
            body: buffer
          });
          
          if (!analyzeResponse.ok) {
            throw new Error(`Azure OCR failed: ${analyzeResponse.status}`);
          }
          
          const operationLocation = analyzeResponse.headers.get('Operation-Location');
          diagnostics.push(`Azure OCR operation started: ${operationLocation}`);
          
          // Poll for results
          let result;
          let attempts = 0;
          while (attempts < 30) { // Max 30 seconds
            await new Promise(resolve => setTimeout(resolve, 1000));
            const resultResponse = await fetch(operationLocation, {
              headers: { 'Ocp-Apim-Subscription-Key': azureKey }
            });
            
            result = await resultResponse.json();
            if (result.status === 'succeeded') break;
            if (result.status === 'failed') throw new Error('Azure OCR failed');
            attempts++;
          }
          
          if (result.status !== 'succeeded') {
            throw new Error('Azure OCR timed out');
          }
          
          // Extract text from results
          text = result.analyzeResult.readResults
            .map(page => page.lines.map(line => line.text).join('\n'))
            .join('\n\n');
            
          diagnostics.push(`Azure OCR successful: ${text.length} characters extracted`);
        } else {
          // Fallback: Try to extract text directly from PDF buffer as plain text
          diagnostics.push(`Azure credentials not found, trying basic text extraction...`);
          const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false });
          const rawText = textDecoder.decode(buffer);
          
          // Look for readable text in the PDF (basic approach)
          const textMatches = rawText.match(/[a-zA-Z0-9\s\-\.\,\:\;\(\)\/\%\$\#\@\!\?\[\]]{20,}/g);
          if (textMatches && textMatches.length > 0) {
            text = textMatches.join('\n').replace(/\s+/g, ' ').trim();
            diagnostics.push(`Basic text extraction found ${text.length} characters`);
          } else {
            throw new Error('No readable text found. This appears to be a scanned PDF. Please provide Azure Computer Vision credentials or convert to .txt format.');
          }
        }
      } catch (e) {
        diagnostics.push(`PDF OCR failed: ${e.message}`);
        throw new Error('PDF processing failed. This appears to be a scanned PDF. Please convert to .txt format or provide text-based PDF.');
      }
    } else {
      throw new Error('Unsupported file type. Please use .txt, .pdf, or code files.');
    }
    
    if (!text || text.trim().length < 50) {
      throw new Error('File has insufficient text content');
    }
    
    diagnostics.push(`Processing ${file.name} - ${text.length} characters`);
    
    // Call Claude API
    let Anthropic;
    try {
      const anthropicModule = await import('@anthropic-ai/sdk');
      Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;
      diagnostics.push(`Anthropic import successful: ${typeof Anthropic}`);
    } catch (e) {
      diagnostics.push(`Anthropic import failed: ${e.message}`);
      throw new Error(`Failed to import Anthropic SDK: ${e.message}`);
    }
    
    const anthropic = new Anthropic({ apiKey });
    
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
  "source": {"fileName": "${file.name}"}
}]

Extract 30-50 key requirements. Focus on critical technical specifications. JSON only.`;

    let completion;
    try {
      diagnostics.push('Calling Claude API...');
      completion = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 3000,
        temperature: 0,
        system: 'You are a mechanical engineer. Extract technical requirements from specifications. Return valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
      });
      diagnostics.push('Claude API call successful');
    } catch (e) {
      diagnostics.push(`Claude API call failed: ${e.message}`);
      throw new Error(`Claude API error: ${e.message}`);
    }
    
    const responseText = completion.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    diagnostics.push(`Claude response length: ${responseText.length} characters`);
    
    let results = [];
    try {
      results = JSON.parse(responseText);
    } catch {
      const start = responseText.indexOf('[');
      const end = responseText.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        results = JSON.parse(responseText.slice(start, end + 1));
      }
    }
    
    if (!Array.isArray(results)) {
      results = [];
    }
    
    diagnostics.push(`Successfully extracted ${results.length} requirements`);
    
    return res.status(200).json({
      results,
      diagnostics
    });
    
  } catch (error) {
    console.error('Spec review error:', error);
    diagnostics.push(`Error: ${error.message}`);
    diagnostics.push(`Stack: ${error.stack}`);
    
    return res.status(500).json({
      error: error.message,
      diagnostics,
      stack: error.stack
    });
  }
}
