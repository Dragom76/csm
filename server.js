/* [수정 일시: 2026-05-19 02:10:00 KST] 본인의 실제 Cloudflare R2 계정 고유 해시 ID(bb4a9796...) 규격으로 주소 일치화 완료 */
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static(path.join(__dirname))); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/posts', async (req, res) => {
    try {
        const { data, error } = await supabase.from('posts').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', upload.single('image'), async (req, res) => {
    try {
        const { title, content } = req.body;
        let image_url = '';

        if (req.file) {
            const fileName = `${Date.now()}_${req.file.originalname}`;
            await r2Client.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype 
            }));
            
            // [교정 핵심] 본인의 진짜 Cloudflare 실서버 계정 고유 ID 해시값으로 완벽히 동기화 타겟팅 변경
            const realAccountHash = "bb4a97963e754ec4a974aad4402fb137";
            image_url = `https://pub-${realAccountHash}.r2.dev/${fileName}`;
        }

        const { data, error } = await supabase.from('posts').insert([{ title, content, image_url }]).select();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/posts/:id', async (req, res) => {
    try {
        const { title, content } = req.body;
        const { data, error } = await supabase.from('posts').update({ title, content }).eq('id', req.params.id).select();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('posts').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/posts/excel', async (req, res) => {
    try {
        const { data: posts, error } = await supabase.from('posts').select('*').order('id', { ascending: false });
        if (error) throw error;

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('ERP_Posts');

        worksheet.columns = [
            { header: '순번', key: 'id', width: 10 },
            { header: '작성일', key: 'created_at', width: 25 },
            { header: '제목', key: 'title', width: 30 },
            { header: '내용', key: 'content', width: 50 },
            { header: '이미지 URL', key: 'image_url', width: 40 }
        ];

        posts.forEach(post => worksheet.addRow(post));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=ERP_Report.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 서버 구동 중'));
