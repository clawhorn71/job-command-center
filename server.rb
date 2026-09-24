#!/usr/bin/env ruby
# frozen_string_literal: true

require "webrick"
require "json"
require "fileutils"
require "securerandom"
require "time"

ROOT = File.expand_path(__dir__)
PUBLIC = File.join(ROOT, "public")
DATA = File.join(ROOT, "data")
INBOX = File.join(DATA, "inbox")
STORE_PATH = File.join(DATA, "store.json")
TOKEN_PATH = File.join(DATA, "token.txt")
PORT = (ENV["PORT"] || "3847").to_i
BIND = ENV["BIND"] || "127.0.0.1"

FileUtils.mkdir_p(INBOX)

def empty_store
  {
    "applications" => [],
    "suggestions" => [],
    "events" => [],
    "bots" => {
      "job_tracker" => { "label" => "Job Tracker", "lastSyncAt" => nil, "records" => 0 },
      "linkedin_job_bot" => { "label" => "LinkedIn Job Bot", "lastSyncAt" => nil, "records" => 0 },
      "job_email_bot" => { "label" => "Job Email Bot", "lastSyncAt" => nil, "records" => 0 }
    },
    "updatedAt" => nil,
    "dismissed" => []
  }
end

def read_json(path, fallback)
  return fallback unless File.exist?(path)
  JSON.parse(File.read(path))
rescue JSON::ParserError
  fallback
end

def write_json(path, object)
  tmp = "#{path}.tmp"
  File.write(tmp, JSON.pretty_generate(object))
  File.rename(tmp, path)
end

def token
  if File.exist?(TOKEN_PATH)
    File.read(TOKEN_PATH).strip
  else
    generated = SecureRandom.hex(16)
    File.write(TOKEN_PATH, generated)
    generated
  end
end

INGEST_TOKEN = token
STORE = read_json(STORE_PATH, empty_store)
STORE["bots"] = empty_store["bots"].merge(STORE["bots"] || {})
STORE["dismissed"] ||= []

def persist!
  STORE["updatedAt"] = Time.now.utc.iso8601
  write_json(STORE_PATH, STORE)
end

def json_response(res, payload, status = 200)
  res.status = status
  res["Content-Type"] = "application/json; charset=utf-8"
  res["Cache-Control"] = "no-store"
  res.body = JSON.pretty_generate(payload)
end

def authorized?(req)
  provided = req["X-Ingest-Token"] || req.query["token"]
  provided.to_s.strip == INGEST_TOKEN
end

def norm(value)
  value.to_s.strip.downcase.gsub(/\s+/, " ")
end

def canon_company(value)
  name = norm(value)
  return "cursor" if name.match?(/\b(cursor|spacexai|anysphere)\b/)
  name
end

def canon_title(value, strip_parens: false)
  title = value.to_s.downcase
  title = title.gsub(/\([^)]*\)/, " ") if strip_parens
  title = title.gsub(/[()]/, " ")
  title = title.tr("–—−/", "    ")
  title = title.gsub(/[^a-z0-9+ ]/, " ")
  title = title.gsub(/\bgov\b/, "government")
  title.gsub(/\s+/, " ").strip
end

def canon_url(value)
  raw = value.to_s.strip
  return "" if raw.empty?
  return "jid:#{Regexp.last_match(1)}" if raw =~ /[?&]gh_jid=(\d+)/i
  return "gh:#{Regexp.last_match(1)}" if raw =~ %r{greenhouse\.io/[^/]+/jobs/(\d+)}i
  return "ashby:#{Regexp.last_match(1)}/#{Regexp.last_match(2)}" if raw =~ %r{ashbyhq\.com/([^/]+)/([0-9a-f-]+)}i
  return "cursor:#{Regexp.last_match(1)}" if raw =~ %r{cursor\.com/careers/([a-z0-9-]+)}i
  url = raw.downcase.sub(%r{\Ahttps://www\.}, "https://").sub(%r{\Ahttp://www\.}, "https://").sub(%r{\Ahttp://}, "https://")
  url.split("#").first.split("?").first.sub(%r{/\z}, "")
end

def role_key(record, strip_parens: false)
  company = canon_company(record["company"])
  title = canon_title(record["title"], strip_parens: strip_parens)
  return nil if company.empty? || title.empty?
  "role:#{company}|#{title}"
end

def url_key(record)
  url = canon_url(record["url"])
  url.empty? ? nil : "url:#{url}"
end

def fingerprints(record)
  keys = [url_key(record), role_key(record)]
  keys << role_key(record, strip_parens: true) if record["title"].to_s.match?(/\(.*\)/)
  keys.compact.uniq
end

def key_for(record)
  fingerprints(record).first
end

STATUS_RANK = {
  "offer" => 60,
  "interview" => 50,
  "onsite" => 50,
  "final" => 50,
  "screening" => 40,
  "recruiter" => 40,
  "phone" => 40,
  "applied" => 30,
  "submitted" => 30,
  "withdrawn" => 20,
  "rejected" => 10,
  "closed" => 10
}.freeze

def status_rank(status)
  STATUS_RANK[status.to_s.strip.downcase] || 0
end

def better_text(a, b)
  a.to_s.strip.length >= b.to_s.strip.length ? a : b
end

def merge_records(left, right)
  merged = left.merge(right) { |key, old_val, new_val|
    case key
    when "id"
      old_val
    when "url"
      old_val.to_s.strip.empty? ? new_val : old_val
    when "company"
      if canon_company(old_val) == "cursor" && canon_company(new_val) == "cursor"
        "Cursor"
      else
        better_text(old_val, new_val)
      end
    when "title", "location", "notes", "matchReason"
      better_text(old_val, new_val)
    when "status"
      status_rank(new_val) >= status_rank(old_val) ? new_val : old_val
    when "appliedAt"
      times = [old_val, new_val].map { |t| Time.parse(t.to_s) rescue nil }.compact
      times.empty? ? old_val : times.min.iso8601
    when "lastUpdateAt"
      times = [old_val, new_val].map { |t| Time.parse(t.to_s) rescue nil }.compact
      times.empty? ? old_val || new_val : times.max.iso8601
    else
      new_val.nil? || new_val.to_s.strip.empty? ? old_val : new_val
    end
  }
  merged["id"] = left["id"] || right["id"] || SecureRandom.uuid
  merged
end

def upsert(list, incoming)
  index = {}
  list.each_with_index do |item, i|
    fingerprints(item).each { |k| index[k] = i }
  end
  incoming.each do |raw|
    next unless raw.is_a?(Hash)
    record = stringify(raw)
    hits = fingerprints(record).map { |k| index[k] }.compact.uniq
    if hits.length == 1
      i = hits.first
      merged = merge_records(list[i], record)
      list[i] = merged
      fingerprints(merged).each { |k| index[k] = i }
    elsif hits.empty?
      record["id"] ||= SecureRandom.uuid
      i = list.length
      list << record
      fingerprints(record).each { |k| index[k] = i }
    else
      keep = hits.min
      hits.sort.reverse.each do |i|
        next if i == keep
        list[keep] = merge_records(list[keep], list[i])
        list.delete_at(i)
      end
      list[keep] = merge_records(list[keep], record)
      index.clear
      list.each_with_index { |item, i| fingerprints(item).each { |k| index[k] = i } }
    end
  end
  dedupe_list(list)
end

def dedupe_list(list)
  n = list.length
  return list if n <= 1
  parent = (0...n).to_a
  find_root = lambda do |i|
    seen = {}
    while parent[i] != i
      break if seen[i]
      seen[i] = true
      parent[i] = parent[parent[i]]
      i = parent[i]
    end
    i
  end
  buckets = {}
  list.each_with_index do |item, i|
    fingerprints(item).each do |fp|
      if buckets.key?(fp)
        a = find_root.call(buckets[fp])
        b = find_root.call(i)
        parent[b] = a unless a == b
      else
        buckets[fp] = i
      end
    end
  end
  groups = Hash.new { |h, k| h[k] = [] }
  list.each_with_index { |item, i| groups[find_root.call(i)] << item }
  groups.values.map { |members| members.reduce { |acc, rec| merge_records(acc, rec) } }
end

def stringify(hash)
  hash.each_with_object({}) do |(k, v), acc|
    acc[k.to_s] = v
  end
end

def dismissed?(record)
  k = key_for(record)
  return true if k && STORE["dismissed"].include?(k)
  STORE["dismissed"].include?("id:#{record["id"]}") if record["id"].to_s.strip != ""
end

def already_applied?(record)
  fps = fingerprints(record)
  return false if fps.empty?
  STORE["applications"].any? { |row| (fingerprints(row) & fps).any? }
end

def remember_dismissed(record)
  keys = fingerprints(record)
  keys << "id:#{record["id"]}" unless record["id"].to_s.strip.empty?
  STORE["dismissed"] = (STORE["dismissed"] + keys).uniq
end

def find_suggestion(id)
  STORE["suggestions"].find { |row| row["id"] == id }
end

def promote_suggestion(suggestion, status: "applied")
  application = suggestion.merge(
    "id" => SecureRandom.uuid,
    "status" => status,
    "appliedAt" => Time.now.utc.iso8601,
    "source" => suggestion["source"] || "linkedin_job_bot",
    "lastUpdateAt" => Time.now.utc.iso8601
  )
  STORE["applications"] = upsert(STORE["applications"], [application])
  STORE["suggestions"].reject! { |row| row["id"] == suggestion["id"] }
  remember_dismissed(suggestion)
  persist!
  application
end

def ingest(payload, source_hint = nil)
  data = stringify(payload)
  bot = (data["bot"] || source_hint || "job_tracker").to_s
  bot = "job_tracker" unless STORE["bots"].key?(bot)

  applications = Array(data["applications"])
  suggestions = Array(data["suggestions"])
  events = Array(data["events"])

  STORE["applications"] = upsert(STORE["applications"], applications)
  STORE["suggestions"] = upsert(STORE["suggestions"], suggestions).reject do |row|
    dismissed?(row) || already_applied?(row)
  end
  events.each do |event|
    next unless event.is_a?(Hash)
    item = stringify(event)
    item["id"] ||= SecureRandom.uuid
    item["at"] ||= Time.now.utc.iso8601
    item["source"] ||= bot
    STORE["events"].unshift(item)
  end
  STORE["events"] = STORE["events"].first(200)

  count = applications.length + suggestions.length + events.length
  STORE["bots"][bot]["lastSyncAt"] = Time.now.utc.iso8601
  STORE["bots"][bot]["records"] = (STORE["bots"][bot]["records"] || 0) + count
  persist!
  { "ok" => true, "bot" => bot, "accepted" => count, "store" => STORE }
end

def drain_inbox
  Dir[File.join(INBOX, "*.json")].sort.each do |path|
    payload = read_json(path, nil)
    next unless payload.is_a?(Hash)
    ingest(payload)
    File.delete(path)
  rescue StandardError => e
    warn "inbox #{File.basename(path)}: #{e.message}"
  end
end

class IngestServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_POST(req, res)
    unless authorized?(req)
      json_response(res, { "error" => "unauthorized" }, 401)
      return
    end
    payload = JSON.parse(req.body.to_s)
    json_response(res, ingest(payload))
  rescue JSON::ParserError
    json_response(res, { "error" => "invalid json" }, 400)
  end
end

class SnapshotServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_GET(_req, res)
    drain_inbox
    json_response(res, STORE)
  end
end

class ApplicationServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_PATCH(req, res)
    id = req.path.sub(%r{\A/api/applications/}, "")
    payload = stringify(JSON.parse(req.body.to_s))
    found = STORE["applications"].find { |row| row["id"] == id }
    unless found
      json_response(res, { "error" => "not found" }, 404)
      return
    end
    found.merge!(payload)
    found["lastUpdateAt"] = Time.now.utc.iso8601
    persist!
    json_response(res, found)
  rescue JSON::ParserError
    json_response(res, { "error" => "invalid json" }, 400)
  end

  alias do_POST do_PATCH
end

class TokenServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_GET(_req, res)
    json_response(res, { "token" => INGEST_TOKEN, "ingestUrl" => "http://#{BIND}:#{PORT}/api/ingest" })
  end
end

class PromoteServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_POST(req, res)
    payload = stringify(JSON.parse(req.body.to_s))
    suggestion = find_suggestion(payload["id"].to_s)
    unless suggestion
      json_response(res, { "error" => "not found" }, 404)
      return
    end
    json_response(res, promote_suggestion(suggestion))
  rescue JSON::ParserError
    json_response(res, { "error" => "invalid json" }, 400)
  end
end

class ApplyServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_POST(req, res)
    payload = stringify(JSON.parse(req.body.to_s))
    suggestion = find_suggestion(payload["id"].to_s)
    unless suggestion
      json_response(res, { "error" => "not found" }, 404)
      return
    end
    url = suggestion["url"].to_s.strip
    application = promote_suggestion(suggestion)
    json_response(res, { "application" => application, "url" => url.empty? ? nil : url })
  rescue JSON::ParserError
    json_response(res, { "error" => "invalid json" }, 400)
  end
end

class DismissServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_POST(req, res)
    payload = stringify(JSON.parse(req.body.to_s))
    suggestion = find_suggestion(payload["id"].to_s)
    unless suggestion
      json_response(res, { "error" => "not found" }, 404)
      return
    end
    remember_dismissed(suggestion)
    STORE["suggestions"].reject! { |row| row["id"] == suggestion["id"] }
    persist!
    json_response(res, { "ok" => true, "id" => suggestion["id"] })
  rescue JSON::ParserError
    json_response(res, { "error" => "invalid json" }, 400)
  end
end

MIME = {
  ".html" => "text/html; charset=utf-8",
  ".css" => "text/css; charset=utf-8",
  ".js" => "application/javascript; charset=utf-8",
  ".svg" => "image/svg+xml",
  ".json" => "application/json; charset=utf-8",
  ".txt" => "text/plain; charset=utf-8"
}.freeze

class StaticServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_GET(req, res)
    rel = req.path == "/" ? "index.html" : req.path.sub(%r{\A/}, "")
    abs = File.expand_path(rel, PUBLIC)
    unless abs.start_with?(PUBLIC) && File.file?(abs)
      json_response(res, { "error" => "not found" }, 404)
      return
    end
    res.status = 200
    res["Content-Type"] = MIME[File.extname(abs)] || "application/octet-stream"
    res["Cache-Control"] = "no-store"
    res.body = File.read(abs)
  end
end

server = WEBrick::HTTPServer.new(
  BindAddress: BIND,
  Port: PORT,
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::INFO)
)

server.mount "/api/ingest", IngestServlet
server.mount "/api/snapshot", SnapshotServlet
server.mount "/api/token", TokenServlet
server.mount "/api/promote", PromoteServlet
server.mount "/api/apply", ApplyServlet
server.mount "/api/dismiss", DismissServlet
server.mount "/api/applications", ApplicationServlet
server.mount "/", StaticServlet

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }

drain_inbox
STORE["applications"] = dedupe_list(STORE["applications"] || [])
STORE["applications"].each do |row|
  row["company"] = "Cursor" if canon_company(row["company"]) == "cursor"
end
STORE["suggestions"] = dedupe_list(STORE["suggestions"] || []).reject { |row| dismissed?(row) || already_applied?(row) }
persist!

$stderr.puts "Job Command Center → http://#{BIND}:#{PORT}"
$stderr.puts "Ingest token stored in data/token.txt"
server.start
