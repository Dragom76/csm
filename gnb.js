// [수정 일시: 2026-05-19 00:23:00 KST] 레이아웃 마크업 동적 삽입 및 프론트엔드 비즈니스 기능 제어 일체 탑재
let allPosts = [];

document.addEventListener("DOMContentLoaded", () => {
    // 1. 기존 헤더 동적 삽입
    const gnbHTML = `
        <header class="erp-header">
            <div class="header-top">
                <div class="logo">ERP SYSTEM</div>
                <div class="user-profile">관리자 님 (Admin)</div>
            </div>
            <nav class="header-nav">
                <ul>
                    <li class="active"><a href="#">게시물 관리</a></li>
                    <li><a href="#">시스템 설정</a></li>
                    <li><a href="#">로그 분석</a></li>
                </ul>
            </nav>
        </header>
    `;
    document.body.insertAdjacentHTML("afterbegin", gnbHTML);

    // 2. HTML 태그 내 제어 이벤트 리스너 수동 바인딩 처리 (인라인 스크립트 배제)
    const btnWrite = document.getElementById('btn-open-write');
    const btnExcel = document.getElementById('btn-download-excel');
    const btnClose = document.getElementById('btn-close-form');
    const btnDelete = document.getElementById('btn-delete');
    const postForm = document.getElementById('post-form');
    const fileInput = document.getElementById('image');

    if (btnWrite) btnWrite.addEventListener('click', openWriteMode);
    if (btnExcel) btnExcel.addEventListener('click', downloadExcel);
    if (btnClose) btnClose.addEventListener('click', showListView);
    if (btnDelete) btnDelete.addEventListener('click', deletePost);
    if (postForm) postForm.addEventListener('submit', handleSubmit);
    if (fileInput) fileInput.addEventListener('change', previewImage);

    // 3. 앱 초기화 동작 시동
    showListView();
    fetchPosts();
});

async function fetchPosts() {
    try {
        const res = await fetch('/api/posts');
        if (!res.ok) throw new Error();
        allPosts = await res.json();
        const tbody = document.getElementById('post-list');
        
        if (!tbody) return;
        if (!allPosts || allPosts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#64748b;">데이터가 없습니다.</td></tr>';
            return;
        }

        tbody.innerHTML = allPosts.map(post => `
            <tr data-id="${post.id}">
                <td>${post.id}</td>
                <td>${post.title}</td>
                <td>${new Date(post.created_at).toLocaleDateString()}</td>
            </tr>
        `).join('');

        // 테이블 열 클릭 리스너 바인딩
        tbody.querySelectorAll('tr').forEach(tr => {
            tr.addEventListener('click', () => {
                const id = tr.getAttribute('data-id');
                if (id) loadPost(parseInt(id));
            });
        });
    } catch (err) {
        console.error("데이터 로드 오류:", err);
        alert("데이터베이스 정보를 불러오는데 실패했습니다.");
    }
}

function showListView() {
    document.getElementById('section-form').classList.remove('active');
    document.getElementById('section-list').classList.add('active');
}

function showFormView() {
    document.getElementById('section-list').classList.remove('active');
    document.getElementById('section-form').classList.add('active');
}

function openWriteMode() {
    resetForm();
    document.getElementById('form-title').innerText = '신규 게시물 등록';
    document.getElementById('btn-delete').style.display = 'none';
    showFormView();
}

function loadPost(id) {
    const post = allPosts.find(p => p.id === id);
    if (!post) return;

    document.getElementById('post-id').value = post.id;
    document.getElementById('title').value = post.title;
    document.getElementById('content').value = post.content;
    document.getElementById('form-title').innerText = `게시물 상세 및 수정 (No. ${post.id})`;
    document.getElementById('btn-delete').style.display = 'block';

    const preview = document.getElementById('preview');
    if (post.image_url) {
        preview.src = post.image_url;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
    showFormView();
}

function resetForm() {
    document.getElementById('post-id').value = '';
    document.getElementById('post-form').reset();
    document.getElementById('preview').style.display = 'none';
}

function previewImage(event) {
    const preview = document.getElementById('preview');
    const files = event.target.files;
    if (files && files.length > 0) {
        preview.src = URL.createObjectURL(files[0]);
        preview.style.display = 'block';
    }
}

async function handleSubmit(event) {
    event.preventDefault();
    const id = document.getElementById('post-id').value;
    const title = document.getElementById('title').value;
    const content = document.getElementById('content').value;

    try {
        if (id) {
            const res = await fetch(`/api/posts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content })
            });
            if (!res.ok) throw new Error();
            alert('게시물이 성공적으로 수정되었습니다.');
        } else {
            const formData = new FormData();
            formData.append('title', title);
            formData.append('content', content);
            
            const fileInput = document.getElementById('image');
            if (fileInput.files && fileInput.files.length > 0) {
                formData.append('image', fileInput.files[0]);
            }

            const res = await fetch('/api/posts', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) throw new Error();
            alert('새 게시물이 안전하게 등록되었습니다.');
        }
        showListView();
        fetchPosts();
    } catch (err) {
        alert('처리 중 오류가 발생했습니다. 입력 정보를 확인해 주세요.');
    }
}

async function deletePost() {
    const id = document.getElementById('post-id').value;
    if (id && confirm('정말 이 게시물을 삭제하시겠습니까?')) {
        try {
            const res = await fetch(`/api/posts/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            alert('게시물이 삭제되었습니다.');
            showListView();
            fetchPosts();
        } catch (err) {
            alert('삭제 처리에 실패했습니다.');
        }
    }
}

function downloadExcel() {
    window.location.href = '/api/posts/excel';
}
