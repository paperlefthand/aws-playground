from fastapi import FastAPI  # ty:ignore[unresolved-import]

app = FastAPI()


@app.get("/")
async def get_root():
    return {"message": "Hello World"}
