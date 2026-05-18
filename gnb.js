/* [수정 일시: 2026-05-19 02:22:00 KST] 상세조회 컨텍스트 내부 엑셀 제어 토글 및 기존 내용 수정 스위치 보완 완료 */
let allPosts = [];

document.addEventListener("DOMContentLoaded", () => {
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

        tbody.querySelectorAll('tr').forEach(tr => {
            tr.addEventListener('click', () => {
                const id = tr.getAttribute('data-id');
                if (id) loadPost(parseInt(id));
            });
        });
    } catch (err) {
        alert("데이터베이스 정보를 읽어오지 못했습니다.");
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
    document.getElementById('btn-download-excel').style.display = 'none'; // 등록 모드일 땐 엑셀 숨김
    document.getElementById('image-upload-wrapper').style.display = 'block'; // 새 글 작성 시 파일 필드 활성화
    showFormView();
}

// 상세 보기 및 기존 내용 수정 제어 활성화
function loadPost(id) {
    const post = allPosts.find(p => p.id === id);
    if (!post) return;

    document.getElementById('post-id').value = post.id;
    document.getElementById('title').value = post.title;
    document.getElementById('content').value = post.content;
    document.getElementById('form-title').innerText = `게시물 상세 및 수정 (No. ${post.id})`;
    
    // 조작 스위치 노출 상태 정비
    document.getElementById('btn-delete').style.display = 'block';
    document.getElementById('btn-download-excel').style.display = 'block'; // 상세 페이지 진입 시 엑셀 버튼 오픈
    document.getElementById('image-upload-wrapper').style.display = 'none'; // 기존 내용 수정 시에는 이미지 필드 제외 처리

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
            // [기능 보완] 기존 내용을 수정한 후 서버(PUT)에 최종 반영 처리
            const res = await fetch(`/api/posts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content })
            });
            if (!res.ok) throw new Error();
            alert('🎉 성공: 기존 내용이 정상적으로 수정 및 업데이트되었습니다.');
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
        alert('❌ 실패: 서버 통신 오류가 발생했습니다.');
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
