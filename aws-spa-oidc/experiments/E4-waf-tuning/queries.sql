-- 実験 E4: WAF ログの分析クエリ(Athena)
--
-- テーブルは CoreStack が作る Glue テーブル:
--   <namePrefix>_waf_logs.edge_waf_logs      … CLOUDFRONT スコープ
--   <namePrefix>_waf_logs.cognito_waf_logs   … COGNITO_USER_POOL スコープ
--
-- パーティション射影を使っているので MSCK REPAIR は不要。
-- 期間は year/month/day で必ず絞ること(全走査は課金が跳ねる)。
--
-- 実行: node experiments/E4-waf-tuning/run.mjs --database=... --workgroup=...

-- name: rule_hits
-- ルール別のヒット数。レポートの「ルール別ヒット数」の表になる。
SELECT
  terminatingruleid,
  action,
  COUNT(*) AS hits
FROM ${table}
WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
GROUP BY terminatingruleid, action
ORDER BY hits DESC;

-- name: counted_samples
-- Count になったリクエストの代表例。誤検知かどうかを人が判断するための材料。
-- 1 ルールあたり最大 20 件に絞る。
SELECT
  terminatingruleid,
  action,
  httprequest.uri AS uri,
  httprequest.clientip AS clientip,
  httprequest.country AS country,
  (SELECT h.value FROM UNNEST(httprequest.headers) AS t(h) WHERE lower(h.name) = 'user-agent' LIMIT 1) AS useragent
FROM ${table}
WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  AND action = 'COUNT'
LIMIT 500;

-- name: blocked_requests
-- Block されたリクエスト。E5 / E6 の実測と突き合わせる。
SELECT
  from_unixtime(timestamp / 1000) AS blocked_at,
  terminatingruleid,
  httprequest.clientip AS clientip,
  httprequest.uri AS uri
FROM ${table}
WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  AND action = 'BLOCK'
ORDER BY timestamp DESC
LIMIT 500;

-- name: rate_rule_timeline
-- レートベースルールの発火を分単位で見る。E5 の閾値・回復時間の裏取りに使う。
SELECT
  date_trunc('minute', from_unixtime(timestamp / 1000)) AS minute,
  terminatingruleid,
  COUNT(*) AS hits
FROM ${table}
WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  AND terminatingruleid LIKE 'RateLimit%'
GROUP BY 1, 2
ORDER BY 1;
