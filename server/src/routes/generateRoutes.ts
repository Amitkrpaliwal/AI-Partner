import { Router } from 'express';
import {
    documentGenerator,
    PresentationRequest,
    ExcelRequest,
    WordRequest,
    HTMLReportRequest
} from '../services/DocumentGenerator';

const router = Router();

// ============================================================================
// GET /api/generate/status - Check generator availability
// ============================================================================
router.get('/status', async (req, res) => {
    try {
        const generators = documentGenerator.getAvailableGenerators();
        res.json({
            status: 'ready',
            generators
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// POST /api/generate/presentation - Generate PowerPoint
// ============================================================================
router.post('/presentation', async (req, res) => {
    try {
        const request: PresentationRequest = req.body;
        const userId = (req as any).userId || 'default';

        if (!request.title || !request.slides || request.slides.length === 0) {
            return res.status(400).json({
                error: 'Missing required fields: title, slides[]'
            });
        }

        console.log(`[GenerateRoutes] Creating presentation: ${request.title}`);
        const result = await documentGenerator.generatePresentation(request, userId);

        res.json({
            success: true,
            message: 'Presentation generated successfully',
            file: result,
            download_url: `/api/files/${result.id}/download`
        });
    } catch (e: any) {
        console.error('[GenerateRoutes] Presentation error:', e);
        res.status(500).json({
            error: e.message || String(e),
            hint: e.message?.includes('not installed')
                ? 'Install the required package: npm install pptxgenjs'
                : undefined
        });
    }
});

// ============================================================================
// POST /api/generate/excel - Generate Excel Workbook
// ============================================================================
router.post('/excel', async (req, res) => {
    try {
        const request: ExcelRequest = req.body;
        const userId = (req as any).userId || 'default';

        if (!request.title || !request.sheets || request.sheets.length === 0) {
            return res.status(400).json({
                error: 'Missing required fields: title, sheets[]'
            });
        }

        console.log(`[GenerateRoutes] Creating Excel: ${request.title}`);
        const result = await documentGenerator.generateExcel(request, userId);

        res.json({
            success: true,
            message: 'Excel workbook generated successfully',
            file: result,
            download_url: `/api/files/${result.id}/download`
        });
    } catch (e: any) {
        console.error('[GenerateRoutes] Excel error:', e);
        res.status(500).json({
            error: e.message || String(e),
            hint: e.message?.includes('not installed')
                ? 'Install the required package: npm install exceljs'
                : undefined
        });
    }
});

// ============================================================================
// POST /api/generate/document - Generate Word Document
// ============================================================================
router.post('/document', async (req, res) => {
    try {
        const request: WordRequest = req.body;
        const userId = (req as any).userId || 'default';

        if (!request.title || !request.content) {
            return res.status(400).json({
                error: 'Missing required fields: title, content'
            });
        }

        console.log(`[GenerateRoutes] Creating Word doc: ${request.title}`);
        const result = await documentGenerator.generateWord(request, userId);

        res.json({
            success: true,
            message: 'Word document generated successfully',
            file: result,
            download_url: `/api/files/${result.id}/download`
        });
    } catch (e: any) {
        console.error('[GenerateRoutes] Word error:', e);
        res.status(500).json({
            error: e.message || String(e),
            hint: e.message?.includes('not installed')
                ? 'Install the required package: npm install docx'
                : undefined
        });
    }
});

// ============================================================================
// POST /api/generate/report - Generate HTML Report
// ============================================================================
router.post('/report', async (req, res) => {
    try {
        const request: HTMLReportRequest = req.body;
        const userId = (req as any).userId || 'default';

        if (!request.title || !request.sections) {
            return res.status(400).json({
                error: 'Missing required fields: title, sections[]'
            });
        }

        console.log(`[GenerateRoutes] Creating HTML report: ${request.title}`);
        const result = await documentGenerator.generateHTML(request, userId);

        res.json({
            success: true,
            message: 'HTML report generated successfully',
            file: result,
            download_url: `/api/files/${result.id}/download`
        });
    } catch (e: any) {
        console.error('[GenerateRoutes] Report error:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// ============================================================================
// POST /api/generate/pdf - Generate PDF Report
// ============================================================================
router.post('/pdf', async (req, res) => {
    try {
        const request: HTMLReportRequest = req.body;
        const userId = (req as any).userId || 'default';

        if (!request.title || !request.sections) {
            return res.status(400).json({
                error: 'Missing required fields: title, sections[]'
            });
        }

        console.log(`[GenerateRoutes] Creating PDF report: ${request.title}`);
        const result = await documentGenerator.generatePDF(request, userId);

        res.json({
            success: true,
            message: 'PDF report generated successfully',
            file: result,
            download_url: `/api/files/${result.id}/download`
        });
    } catch (e: any) {
        console.error('[GenerateRoutes] PDF error:', e);
        res.status(500).json({
            error: e.message || String(e),
            hint: e.message?.includes('Playwright')
                ? 'Install Playwright: npm install playwright && npx playwright install chromium'
                : undefined
        });
    }
});

// ============================================================================
// POST /api/generate/from-prompt - AI-assisted generation (requires LLM)
// ============================================================================
router.post('/from-prompt', async (req, res) => {
    try {
        const { prompt, type = 'presentation' } = req.body;
        const user_id = (req as any).userId || 'default';

        if (!prompt) {
            return res.status(400).json({ error: 'Missing required field: prompt' });
        }

        // This endpoint would use the LLM to parse the prompt and generate structured data
        // For now, return a placeholder response indicating this requires LLM integration
        res.status(501).json({
            error: 'AI-assisted generation requires LLM integration',
            message: 'Use the structured endpoints (/presentation, /excel, /document, /report) directly',
            hint: 'Or integrate with AgentOrchestrator for natural language generation'
        });

    } catch (e: any) {
        console.error('[GenerateRoutes] From-prompt error:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

export const generateRoutes = router;
