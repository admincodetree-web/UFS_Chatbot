import os
import sys
import re
import json
import asyncio
import threading
import traceback
import datetime
from typing import List
from dotenv import load_dotenv
from os import getenv

from flask import Flask, request, jsonify, session, render_template, send_from_directory
from flask_cors import CORS
from flask_session import Session
from werkzeug.utils import secure_filename

from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

# MCP client imports
from mcp import ClientSession as McpClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from langchain_mcp_adapters.tools import load_mcp_tools

from PyPDF2 import PdfReader
from docx import Document
import csv
import openpyxl
import xlrd

# --- CONFIGURATION ---
load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app, supports_credentials=True)
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "dev_secret")
app.config['SESSION_TYPE'] = 'filesystem'
app.config['SESSION_PERMANENT'] = False
Session(app)

UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
ALLOWED_EXTENSIONS = set(os.getenv("ALLOWED_EXTENSIONS", "pdf,docx,txt,csv,xls,xlsx,png,jpg,jpeg").split(","))

SENSITIVE_COLUMNS = [col.strip().lower() for col in os.getenv("SENSITIVE_COLUMNS", "").split(",") if col.strip()]
BLOCKED_QUERIES = [word.strip().lower() for word in os.getenv("BLOCKED_QUERIES", "").split(",") if word.strip()]

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# MCP agent globals
_async_loop = None
mcp_agent_executor = None
fallback_llm = None

# --- UTILITIES ---
def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_text_from_file(filepath: str) -> str:
    ext = filepath.split('.')[-1].lower()
    text = ""
    try:
        if ext == "pdf":
            with open(filepath, "rb") as f:
                text = "\n".join([(page.extract_text() or "") for page in PdfReader(f).pages])
        elif ext in ["doc", "docx"]:
            text = "\n".join([p.text for p in Document(filepath).paragraphs])
        elif ext == "txt":
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        elif ext == "csv":
            with open(filepath, newline='', encoding="utf-8", errors="ignore") as f:
                text = "\n".join([",".join([str(c) for c in row]) for row in csv.reader(f)])
        elif ext in ["xls", "xlsx"]:
            if ext == "xlsx":
                wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
                rows = [",".join([str(cell) if cell is not None else "" for cell in row]) for row in wb.active.iter_rows(values_only=True)]
                text = "\n".join(rows)
            else:
                wb = xlrd.open_workbook(filepath)
                sheet = wb.sheet_by_index(0)
                rows = [",".join([str(sheet.cell_value(i, j)) for j in range(sheet.ncols)]) for i in range(sheet.nrows)]
                text = "\n".join(rows)
        else:
            text = "Unsupported file format."
    except Exception as e:
        text = f"Error reading file: {e}"
    return text.strip()

def detect_sensitive_query(text: str) -> bool:
    query_lower = (text or "").lower()
    if any(word in query_lower for word in BLOCKED_QUERIES):
        return True
    if any(re.search(rf"\b{re.escape(col)}\b", query_lower) for col in SENSITIVE_COLUMNS):
        if "count" in query_lower or "how many" in query_lower:
            return False
        return True
    return False

def get_fallback_response(prompt: str) -> str:
    global fallback_llm
    if not fallback_llm:
        return "Error: LLM not initialized."
    try:
        system = "You are a helpful assistant for the Andhra Pradesh Family Survey data system."
        resp = fallback_llm.invoke([HumanMessage(content=system + "\n\n" + prompt)])
        return resp.content if isinstance(resp.content, str) else str(resp.content)
    except Exception as e:
        return f"Error in fallback LLM: {e}"

# --- MCP SYSTEM PROMPT ---
MCP_SYSTEM_PROMPT = """
You are a helpful data analyst assistant for the Andhra Pradesh Universal Family Survey (UFS) system.
You help government officials and administrators understand survey data from the UFS_CITIZEN_DATA table.

You have ONE tool: run_readonly_sql_query.
Use it for ALL data questions — always query the database to get accurate data.
NEVER guess or make up numbers.

GUIDELINES FOR WRITING QUERIES:
- This is an Oracle database. Use Oracle SQL syntax.
- Use FETCH FIRST N ROWS ONLY instead of LIMIT N.
- Use UPPER(column) = UPPER('value') for case-insensitive text comparisons.
- Use TO_CHAR(date_col, 'DD-MM-YYYY') when displaying dates.
- For percentages, calculate as: ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM UFS_CITIZEN_DATA), 2)
- For aggregations, GROUP BY all non-aggregate columns.
- Do NOT include sensitive columns (AADHAAR_NUMBER, MOBILE_NUMBER, FATHER_HUSBAND_AADHAAR, HUSBAND_AADHAAR) in output.

RESPONSE FORMATTING:
1. Always use Markdown for responses.
2. For single values: answer in one or two clear sentences.
3. For tabular/grouped data: use a Markdown table with clean column headers.
4. Do NOT use bold (**) inside table cells — plain text only in cells.
5. Format all dates as DD-MM-YYYY. Do NOT show time unless explicitly asked.
6. If results are empty, say so clearly and suggest why.
7. After presenting data, add a brief 1-line insight if it is useful.
""".strip()

# --- MCP BACKGROUND WORKER ---
def _run_async(coro):
    """Run an async coroutine on the dedicated event loop and wait for the result."""
    if _async_loop is None or not _async_loop.is_running():
        return asyncio.run(coro)
    future = asyncio.run_coroutine_threadsafe(coro, _async_loop)
    return future.result(timeout=120)

def _mcp_background_worker(llm):
    """Run the MCP client and agent within a dedicated event loop."""
    global _async_loop, mcp_agent_executor
    _async_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_async_loop)

    async def run_session():
        global mcp_agent_executor
        mcp_server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")
        server_params = StdioServerParameters(
            command=sys.executable,
            args=[mcp_server_path],
            env={**os.environ},
        )
        print(f"Connecting to MCP server: {sys.executable} {mcp_server_path}")
        try:
            async with stdio_client(server_params) as (read, write):
                async with McpClientSession(read, write) as mcp_session:
                    await mcp_session.initialize()
                    tools = await load_mcp_tools(mcp_session)
                    print(f"MCP tools loaded: {[t.name for t in tools]}")
                    agent_prompt = ChatPromptTemplate.from_messages([
                        ("system", MCP_SYSTEM_PROMPT),
                        MessagesPlaceholder(variable_name="messages"),
                    ])
                    mcp_agent_executor = create_react_agent(model=llm, tools=tools, prompt=agent_prompt)
                    print("MCP-based ReAct agent created successfully.")
                    await asyncio.Event().wait()
        except Exception as e:
            print("Error in MCP background session:", e, traceback.format_exc())
            mcp_agent_executor = None

    try:
        _async_loop.run_until_complete(run_session())
    except Exception as e:
        print("MCP background worker crashed:", e)

# --- INITIALIZATION ---
def initialize_agents():
    global fallback_llm

    GEMINI_API_KEY = getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
    GEMINI_MODEL = getenv("GEMINI_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"

    try:
        llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=GEMINI_API_KEY, temperature=0)
        fallback_llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=GEMINI_API_KEY, temperature=0.2)
        print(f"LLMs initialized (model: {GEMINI_MODEL}).")
    except Exception as e:
        print("LLM initialization error:", e)
        return

    mcp_thread = threading.Thread(target=_mcp_background_worker, args=(llm,), daemon=True)
    mcp_thread.start()

# --- ROUTES ---
@app.route('/')
def index():
    template_name = "index.html"
    template_path = os.path.join(app.root_path, "templates", template_name)
    file_root = os.path.join(app.root_path, template_name)
    if os.path.exists(template_path):
        return render_template(template_name)
    if os.path.exists(file_root):
        return send_from_directory(app.root_path, template_name)
    return f"Missing {template_name} in templates/ or project root.", 404

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    f = request.files['file']
    if f.filename == "" or not allowed_file(f.filename):
        return jsonify({"error": "Invalid file"}), 400
    filename = secure_filename(f.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    try:
        f.save(filepath)
        extracted_text = extract_text_from_file(filepath)
        session['uploaded_context'] = extracted_text
        session.modified = True
        return jsonify({"message": "uploaded", "filename": filename, "content": extracted_text})
    except Exception:
        return jsonify({"error": "Upload failed"}), 500

@app.route('/api/chat', methods=['POST'])
def query_route():
    global mcp_agent_executor
    data = request.get_json() or {}
    message = (data.get("message") or "").strip()
    file_content = data.get("file_content")

    if not message and not file_content:
        return jsonify({"response": "Please enter a valid query."}), 400

    if file_content:
        session['uploaded_context'] = file_content
        session.modified = True

    if detect_sensitive_query(message):
        return jsonify({"response": "Sorry - I cannot provide sensitive personal data. You can ask for aggregated counts though."})

    # Build in-session conversation history (keeps context within the current session)
    if 'chat_history' not in session:
        session['chat_history'] = []

    conversation_history: List = []
    for m in session['chat_history'][-20:]:  # last 20 messages for efficiency
        if m['role'] == 'user':
            conversation_history.append(HumanMessage(content=m['content']))
        else:
            conversation_history.append(AIMessage(content=m['content']))
    conversation_history.append(HumanMessage(content=message))

    ai_response = "An error occurred."
    agent_error = None

    if mcp_agent_executor is not None:
        try:
            async def _invoke_agent():
                return await mcp_agent_executor.ainvoke({"messages": conversation_history})

            response_graph = _run_async(_invoke_agent())

            # Pretty-print tool calls to terminal
            try:
                SEP = "=" * 64
                all_msgs = response_graph.get("messages", []) if isinstance(response_graph, dict) else []
                for msg in all_msgs:
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            tc_name = tc.get("name", "unknown") if isinstance(tc, dict) else getattr(tc, "name", "unknown")
                            tc_args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
                            print(f"\n{SEP}", flush=True)
                            print(f"  TOOL INVOKED : {tc_name}", flush=True)
                            if "query" in tc_args:
                                print(f"  SQL QUERY    :", flush=True)
                                print(f"{SEP}", flush=True)
                                for line in tc_args["query"].strip().split("\n"):
                                    print(f"  {line}", flush=True)
                            else:
                                print(f"  ARGS         : {json.dumps(tc_args, ensure_ascii=False)}", flush=True)
                            print(f"{SEP}\n", flush=True)
                    if hasattr(msg, "name") and msg.__class__.__name__ == "ToolMessage":
                        tool_name = getattr(msg, "name", "tool")
                        print(f"\n{SEP}", flush=True)
                        print(f"  TOOL RESULT  : {tool_name}", flush=True)
                        print(f"{SEP}", flush=True)
                        try:
                            parsed = json.loads(msg.content)
                            print(json.dumps(parsed, indent=2, ensure_ascii=False)[:2000])
                        except Exception:
                            print(str(msg.content)[:2000])
                        print(f"{SEP}\n")
            except Exception as log_err:
                print(f"[Log] Could not extract tool call info: {log_err}")

            # Extract final response
            if isinstance(response_graph, dict) and "messages" in response_graph:
                final_msg = response_graph["messages"][-1]
                raw = final_msg.content if isinstance(final_msg, AIMessage) else final_msg
            elif isinstance(response_graph, AIMessage):
                raw = response_graph.content
            else:
                raw = response_graph

            if isinstance(raw, str):
                ai_response = raw
            elif isinstance(raw, (list, dict)):
                ai_response = json.dumps(raw, ensure_ascii=False)
            else:
                ai_response = str(raw)

        except Exception as e:
            print("MCP Agent invocation error:", e, traceback.format_exc())
            agent_error = e
    else:
        agent_error = RuntimeError("MCP agent not yet initialized. Please wait a moment and try again.")

    if agent_error is not None:
        if fallback_llm:
            ai_response = get_fallback_response(message)
        else:
            ai_response = f"Agent error: {agent_error}"

    # Clean up list/dict responses
    try:
        if isinstance(ai_response, str):
            clean = ai_response.strip()
            if clean.startswith("```"):
                clean = clean[7:] if clean.startswith("```json") else clean[3:]
                if clean.endswith("```"):
                    clean = clean[:-3]
                clean = clean.strip()
            if (clean.startswith("[") and clean.endswith("]")) or (clean.startswith("{") and clean.endswith("}")):
                try:
                    parsed = json.loads(clean)
                    if isinstance(parsed, list) and len(parsed) > 0 and "text" in parsed[0]:
                        ai_response = parsed[0]["text"]
                    elif isinstance(parsed, dict) and "text" in parsed:
                        ai_response = parsed["text"]
                except json.JSONDecodeError:
                    pass
    except Exception:
        pass

    # Save to session history (in-memory only, no DB)
    session['chat_history'].append({'role': 'user', 'content': message})
    session['chat_history'].append({'role': 'bot', 'content': str(ai_response)})
    # Cap session history at 40 messages (20 turns) to avoid bloat
    if len(session['chat_history']) > 40:
        session['chat_history'] = session['chat_history'][-40:]
    session.modified = True

    return jsonify({"response": str(ai_response)})

# Initialize agents when module is loaded (required for gunicorn/Render)
initialize_agents()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
