// Deno Deploy Docker 镜像代理（适配自你的CF代码）
const hub_host = 'registry-1.docker.io';
const auth_url = 'https://auth.docker.io';
const 屏蔽爬虫UA = ['netcraft'];

// 路由表
function routeByHosts(host: string) {
	const routes = {
		"quay": "quay.io",
		"gcr": "gcr.io",
		"k8s-gcr": "k8s.gcr.io",
		"k8s": "registry.k8s.io",
		"ghcr": "ghcr.io",
		"cloudsmith": "docker.cloudsmith.io",
		"nvcr": "nvcr.io",
		"test": "registry-1.docker.io",
	};
	return (host in routes) ? [routes[host], false] : [hub_host, true];
}

const PREFLIGHT_INIT = {
	headers: new Headers({
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
		'access-control-max-age': '1728000',
	}),
};

function makeRes(body: BodyInit | null, status = 200, headers = {}) {
	headers['access-control-allow-origin'] = '*';
	return new Response(body, { status, headers });
}

// Nginx 伪装页
async function nginx() {
	return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>body{width:35em;margin:0 auto;font-family:Tahoma,Verdana,Arial,sans-serif;}</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
<p>Refer to <a href="http://nginx.org/">nginx.org</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

// Docker 搜索页面
async function searchInterface() {
	return `<!DOCTYPE html>
<html>
<head>
<title>Docker Hub 镜像搜索</title>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--primary:#0066ff;--gradient:linear-gradient(135deg,#1a90ff,#003eb3);}
body{margin:0;padding:20px;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--gradient);color:white;font-family:sans-serif;}
.container{text-align:center;max-width:600px;width:100%;}
.search{display:flex;height:50px;box-shadow:0 10px 25px rgba(0,0,0,0.1);border-radius:12px;overflow:hidden;}
.search input{flex:1;padding:0 20px;border:none;outline:none;}
.search button{width:60px;background:var(--primary);color:white;border:none;cursor:pointer;}
</style>
</head>
<body>
<div class="container">
<h1>Docker Hub 镜像搜索</h1>
<div class="search">
<input id="search" placeholder="搜索镜像：nginx mysql redis">
<button onclick="search()">→</button>
</div>
</div>
<script>
function search(){const q=document.getElementById('search').value;q&&(window.location.href='/search?q='+encodeURIComponent(q));}
document.getElementById('search').addEventListener('keypress',e=>e.key==='Enter'&&search());
window.onload=()=>document.getElementById('search').focus();
</script>
</body>
</html>`;
}

// 核心服务
Deno.serve(async (request) => {
	const url = new URL(request.url);
	const userAgent = (request.headers.get('User-Agent') || "").toLowerCase();
	const workers_url = `https://${url.hostname}`;
	const ns = url.searchParams.get('ns');
	const hostTop = url.hostname.split('.')[0];
	
	let currentHub = hub_host;
	let fakePage = true;

	// 路由处理
	if (ns) {
		currentHub = ns === 'docker.io' ? 'registry-1.docker.io' : ns;
	} else {
		const [host, isFake] = routeByHosts(hostTop);
		currentHub = host;
		fakePage = isFake;
	}

	// 屏蔽爬虫
	if (屏蔽爬虫UA.some(f => userAgent.includes(f))) {
		return new Response(await nginx(), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
	}

	// 浏览器访问 / 显示搜索页
	if (url.pathname === '/' && userAgent.includes('mozilla')) {
		return new Response(await searchInterface(), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
	}

	// Token 认证处理
	if (url.pathname.includes('/token')) {
		const tokenUrl = new URL(auth_url + url.pathname + url.search);
		return fetch(new Request(tokenUrl, request));
	}

	// Docker V2 接口处理（核心：manifests/blobs/tags 自动带 Token）
	if (url.pathname.startsWith('/v2/') && (url.pathname.includes('/manifests/') || url.pathname.includes('/blobs/') || url.pathname.includes('/tags/'))) {
		const repoMatch = url.pathname.match(/^\/v2\/(.+?)(?:\/(manifests|blobs|tags)\/)/);
		if (repoMatch) {
			const repo = repoMatch[1];
			const tokenRes = await fetch(`${auth_url}/token?service=registry.docker.io&scope=repository:${repo}:pull`);
			const token = (await tokenRes.json()).token;
			
			const headers = new Headers(request.headers);
			headers.set('Host', currentHub);
			headers.set('Authorization', `Bearer ${token}`);
			
			const targetUrl = new URL(url);
			targetUrl.hostname = currentHub;
			return fetch(new Request(targetUrl, { ...request, headers }));
		}
	}

	// 标准代理请求
	const targetUrl = new URL(url);
	targetUrl.hostname = currentHub;
	const headers = new Headers(request.headers);
	headers.set('Host', currentHub);

	let res = await fetch(new Request(targetUrl, { ...request, headers }));
	
	// 修复认证地址
	const authHeader = res.headers.get("Www-Authenticate");
	if (authHeader) {
		const newHeaders = new Headers(res.headers);
		newHeaders.set("Www-Authenticate", authHeader.replace(auth_url, workers_url));
		res = new Response(res.body, { status: res.status, headers: newHeaders });
	}

	return res;
});
