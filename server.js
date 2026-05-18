require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // 현재 폴더의 정적 파일 서빙

// 1. 서비스 연결 설정
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// 2. 이미지 업로드를 위한 Multer 설정 (메모리 저장 방식)
const upload = multer({ storage: multer.memoryStorage() });

// [API 1] 게시글 전체 리스트 조회 (R)
app.get('/api/posts', async (req, res) => {
    const { data, error } = await supabase.from('posts').select('*').order('id', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// [API 2] 게시글 쓰기 (C) 및 Cloudflare R2 이미지 업로드
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
            // R2 엔드포인트 주소를 기반으로 대외 주소 생성 (서브도메인 환경에 맞춰 조정 필요)
            const publicEndpoint = process.env.R2_ENDPOINT.replace('://cloudflarestorage.com', 'r2.dev');
            image_url = `${publicEndpoint}/${process.env.R2_BUCKET_NAME}/${fileName}`;
        }

        const { data, error } = await supabase.from('posts').insert([{ title, content, image_url }]).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API 3] 게시글 수정 (U)
app.put('/api/posts/:id', async (req, res) => {
    const { title, content } = req.body;
    const { data, error } = await supabase.from('posts').update({ title, content }).eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// [API 4] 게시글 삭제 (D)
app.delete('/api/posts/:id', async (req, res) => {
    const { error } = await supabase.from('posts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// [API 5] 데이터 엑셀 다운로드
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

// 메인 페이지 접속 시 index.html 서빙
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 서버 구동 중: 포트 ${PORT}`));
