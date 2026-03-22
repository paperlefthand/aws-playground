from fastapi import FastAPI
import uvicorn

app = FastAPI()


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint for the API.

    Returns:
        A dictionary containing a "Hello World" message.
    """
    return {"message": "Hello World"}


def main() -> None:
    """Main entry point for running the application locally."""
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)


if __name__ == "__main__":
    main()
