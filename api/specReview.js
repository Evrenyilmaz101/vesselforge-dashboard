// Vercel serverless function for spec review
export default async function handler(req, res) {
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

    // Process first file
    const file = files[0];
    diagnostics.push(`Downloading ${file.name} from ${file.url}`);
    
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
      // Simple PDF text extraction for basic PDFs
      try {
        const pdfParse = await import('pdf-parse');
        const data = await pdfParse.default(buffer);
        text = data.text;
        diagnostics.push(`PDF parsed successfully: ${text.length} characters`);
      } catch (e) {
        diagnostics.push(`PDF parsing failed: ${e.message}`);
        throw new Error('PDF processing failed. Please convert to .txt format first.');
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
        model: 'claude-3-sonnet-20240229',
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
