/* [수정 일시: 2026-05-19 01:15:00 KST] R2 계정 ID 직접 대입 바인딩으로 문자열 변환 처리 버그 영구 제거 */
let allPosts = [];

document.addEventListener("DOMContentLoaded", () => {
    console.log("🔍 [로그] ERP 시스템 프론트엔드가 구동되었습니다.");
    
    const gnbHTML = `
        <header class="erp-header">
            <div class="header-top">
                <div class="logo">ERP SYSTEM</div>
                <div class="user-profile">관리자 님 (Admin)</div>
            </div>
            <nav class="header-nav">
                <ul>
                    <li class="active"><a href="#" id="menu-board-link">게시물 관리</a></li>
                    <li><a href="#">시스템 설정</a></li>
                    <li><a href="#">로그 분석</a></li>
                </ul>
            </nav>
        </header>
    `;
    document.body.insertAdjacentHTML("afterbegin", gnbHTML);

    const btnWrite = document.getElementById('btn-open-write');
    const btnExcel = document.getElementById('btn-download-excel');
    const btnClose = document.getElementById('btn-close-form');
    const btnDelete = document.getElementById('btn-delete');
    const postForm = document.getElementById('post-form');
    const fileInput = document.getElementById('image');
    const menuLink = document.getElementById('menu-board-link');

    if (btnWrite) btnWrite.addEventListener('click', openWriteMode);
    if (btnExcel) btnExcel.addEventListener('click', downloadExcel);
    if (btnClose) btnClose.addEventListener('click', showListView);
    if (btnDelete) btnDelete.addEventListener('click', deletePost);
    if (postForm) postForm.addEventListener('submit', handleSubmit);
    if (fileInput) fileInput.addEventListener('change', previewImage);
    if (menuLink) menuLink.addEventListener('click', (e) => { e.preventDefault(); showListView(); });

    showListView();
    fetchPosts();
});

async function fetchPosts() {
    console.log("📡 [로그] 백엔드 서버(/api/posts)에 데이터를 요청합니다...");
    try {
        const res = await fetch('/api/posts');
        
        console.log("📊 [로그] 서버 응답 상태 코드:", res.status);
        if (!res.ok) {
            const errorText = await res.text();
            console.error("❌ [로그] 서버가 에러를 반환했습니다. 내용:", errorText);
            throw new Error();
        }

        allPosts = await res.json();
        console.log("📦 [로그] 데이터베이스로부터 받아온 실시간 데이터 목록:", allPosts);
        
        const tbody = document.getElementById('post-list');
        if (!tbody) {
            console.error("❌ [로그] HTML 내부에 'post-list' ID를 가진 tbody 태그를 찾을 수 없습니다.");
            return;
        }

        if (!allPosts || allPosts.length === 0) {
            console.warn("⚠️ [로그] 통신은 성공했으나 데이터베이스에 저장된 게시글이 0개(비어있음)입니다.");
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

        tbody.querySelectorAll('tr').forEach(tr => {
            tr.addEventListener('click', () => {
                const id = tr.getAttribute('data-id');
                if (id) loadPost(parseInt(id));
            });
        });
        console.log("✅ [로그] 화면 테이블에 데이터 맵핑이 정상 완료되었습니다.");

    } catch (err) {
        console.error("💥 [로그] 최상위 데이터 통신 예외 에러 발생:", err);
        alert("데이터베이스 정보를 읽어오지 못했습니다. F12 콘솔 로그를 확인해 주세요.");
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
            alert('🎉 성공: 게시물이 정상적으로 수정되었습니다.');
        } else {
            const formData = new FormData();
            formData.append('title', title);
            formData.append('content', content);
            
            const fileInput = document.getElementById('image');
            if (fileInput && fileInput.files && fileInput.files.length > 0) {
                formData.append('image', fileInput.files[0]); 
            }

            const res = await fetch('/api/posts', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) throw new Error();
            alert('🎉 성공: 새 게시물이 마스터 데이터베이스에 등록되었습니다.');
        }
        showListView();
        fetchPosts();
    } catch (err) {
        alert('❌ 실패: 서버 반영에 실패했습니다.');
    }
}

async function deletePost() {
    const id = document.getElementById('post-id').value;
    if (id && confirm('정말 이 게시물을 영구 삭제하시겠습니까?')) {
        try {
            const res = await fetch(`/api/posts/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            alert('🗑️ 처리 완료: 해당 데이터가 정상적으로 삭제되었습니다.');
            showListView();
            fetchPosts();
        } catch (err) {
            alert('❌ 실패: 원격 제어 삭제 처리에 실패했습니다.');
        }
    }
}

function downloadExcel() {
    window.location.href = '/api/posts/excel';
}
