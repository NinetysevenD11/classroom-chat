import os
from dotenv import load_dotenv
import google.generativeai as genai

# .env 파일에서 키를 읽어옵니다.
load_dotenv()
api_key = os.environ.get("GEMINI_API_KEY", "")

if not api_key:
    print("❌ 에러: .env 파일에 GEMINI_API_KEY가 없거나 비어있습니다!")
else:
    print(f"✅ 내 API 키 확인됨: {api_key[:5]}...{api_key[-5:]}")
    genai.configure(api_key=api_key)
    
    print("\n🔍 구글 서버 접속 중... (내 키로 쓸 수 있는 모델 목록을 가져옵니다)")
    try:
        models = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods]
        for m in models:
            print(f" - {m}")
        print("\n💡 [해결책] 위 목록에 있는 이름 중 'gemini-1.5'가 들어간 이름을 복사해서 analyze.py에 넣으세요.")
    except Exception as e:
        print(f"\n❌ API 키 자체가 막혀있거나 연결 에러입니다: {e}")