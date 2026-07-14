<?php
header('Content-Type: application/json');
$id = $_GET['id'] ?? '';
if (!$id) {
    echo json_encode(['success' => false, 'data' => []]);
    exit;
}
$ch = curl_init('http://85.185.251.108:8007/home/popfeeder?id=' . urlencode($id));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => [
        'Accept: application/json, text/plain, */*',
        'Accept-Language: en-US,en;q=0.9,fa-IR;q=0.8,fa;q=0.7',
        'Origin: http://www.kpedc.com',
        'Referer: http://www.kpedc.com/',
        'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    ],
]);
echo curl_exec($ch);
