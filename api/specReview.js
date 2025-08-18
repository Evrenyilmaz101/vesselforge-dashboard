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
          
          // Clean up the extracted text to remove PDF binary data
          let cleanText = rawText
            // Remove PDF binary markers and control characters
            .replace(/%PDF-[\d\.]+/g, '')
            .replace(/%%EOF/g, '')
            .replace(/\/[A-Z][a-zA-Z0-9]+/g, '')
            .replace(/\d+\s+\d+\s+obj/g, '')
            .replace(/endobj/g, '')
            .replace(/stream[\s\S]*?endstream/g, '')
            .replace(/xref/g, '')
            .replace(/trailer/g, '')
            .replace(/startxref/g, '')
            // Remove non-printable characters but keep basic punctuation
            .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
            // Clean up multiple spaces and normalize whitespace
            .replace(/\s+/g, ' ')
            .trim();
          
          // Look for readable text patterns (technical specifications)
          const textMatches = cleanText.match(/[a-zA-Z][a-zA-Z0-9\s\-\.\,\:\;\(\)\/\%\$\#\@\!\?\[\]]{15,}/g);
          if (textMatches && textMatches.length > 5) {
            text = textMatches
              .filter(match => match.length > 20) // Filter out short fragments
              .join('\n')
              .replace(/\s+/g, ' ')
              .trim();
            diagnostics.push(`Basic text extraction found ${text.length} characters`);
          } else {
            // If we can't extract meaningful text, provide a clear message to Claude
            text = `This appears to be a scanned or image-based PDF document. The basic text extraction could not find readable technical specifications. Please note: This document may contain technical drawings, specifications, or requirements that need OCR processing to extract properly.

File name: ${file.name}
File size: ${buffer.byteLength} bytes
Content type: PDF document

To properly extract requirements from this document, please:
1. Convert to a text-based format (.txt, .docx)
2. Or provide Azure Computer Vision credentials for OCR processing
3. Or manually extract key technical requirements

If this document contains technical specifications, standards, materials, dimensions, pressures, temperatures, or other engineering requirements, please provide them in text format.`;
            diagnostics.push(`Could not extract readable text, providing guidance message to Claude`);
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
    
    // Send PDF directly to Claude instead of extracted text
    const prompt = `Please perform a comprehensive technical specification review of this document. Extract ALL technical requirements, specifications, standards, and critical details.

EXTRACT ALL OF THESE:
1. Dimensions, sizes, measurements with tolerances
2. Material specifications, grades, properties
3. Pressure ratings, temperature limits, flow rates
4. Standards and codes (ASME, API, ASTM, ISO, etc.)
5. Testing requirements, inspection criteria
6. Manufacturing/fabrication specifications
7. Quality requirements, acceptance criteria
8. Safety requirements and limits
9. Performance specifications
10. Documentation and certification requirements

For EACH requirement found, create a JSON object with:
- id: sequential number (req_1, req_2, etc.)
- category: one of [Design, Materials, Code, Testing, Fabrication, Documentation, Quality, Safety, Dimensional, Performance]
- requirement: the specific technical requirement with exact values/tolerances
- rationale: brief explanation of why this requirement is important
- source: {"fileName": "${file.name}"}

IMPORTANT:
- Review the ENTIRE document thoroughly - all pages, sections, tables, appendices
- Extract EVERYTHING technical, even if it seems minor
- Include ALL numbers, dimensions, pressures, temperatures, etc.
- Don't skip requirements - be comprehensive and systematic
- Look for specifications in tables, lists, paragraphs, and notes
- Extract 50-100+ requirements if they exist in the document

Return ONLY a JSON array of requirements. No other text.`;

    let completion;
    try {
      diagnostics.push('Sending PDF directly to Claude API...');
      completion = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000, // Increased for comprehensive analysis
        temperature: 0,
        system: 'You are a mechanical engineer performing comprehensive specification reviews. Analyze the entire document thoroughly and return valid JSON only.',
        messages: [{ 
          role: 'user', 
          content: [
            {
              type: 'text',
              text: prompt
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
                data: Buffer.from(buffer).toString('base64')
              }
            }
          ]
        }],
      });
      diagnostics.push('Claude API call successful');
    } catch (e) {
      diagnostics.push(`Claude API call failed: ${e.message}`);
      throw new Error(`Claude API error: ${e.message}`);
    }
    
    const responseText = completion.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    diagnostics.push(`Claude response length: ${responseText.length} characters`);
    diagnostics.push(`Claude response preview: ${responseText.substring(0, 1000)}`);
    
    let results = [];
    try {
      results = JSON.parse(responseText);
      diagnostics.push(`Direct JSON parse successful: ${results.length} items`);
    } catch (parseError) {
      diagnostics.push(`Direct JSON parse failed: ${parseError.message}`);
      
      const start = responseText.indexOf('[');
      const end = responseText.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          results = JSON.parse(responseText.slice(start, end + 1));
          diagnostics.push(`Extracted JSON parse successful: ${results.length} items`);
        } catch (extractError) {
          diagnostics.push(`Extracted JSON parse failed: ${extractError.message}`);
          diagnostics.push(`Extracted JSON text: ${responseText.slice(start, end + 1)}`);
        }
      } else {
        diagnostics.push(`No JSON array brackets found in response`);
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
