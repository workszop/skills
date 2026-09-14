---
title: RAG Architecture Guide
category: TECHNICAL PUBLICATION
date: May 2026
author: md2web
subtitle: Retrieval-Augmented Generation patterns for enterprise AI systems.
---

## What is RAG

Retrieval-Augmented Generation (RAG) is an architecture pattern that grounds large language model outputs in verified, up-to-date knowledge. Instead of relying solely on weights baked in at training time, the model retrieves relevant context from an external store at inference time.

The pattern addresses three core enterprise concerns: **accuracy**, **auditability**, and **freshness**. Every answer can be traced back to a source document — a property that matters when the audience is a compliance officer, not a developer.

## Core components

### 1. Ingestion pipeline

The pipeline transforms raw documents into searchable vectors:

1. **Chunking** — split documents into semantically coherent segments (512–1024 tokens is the standard starting point)
2. **Embedding** — encode each chunk with a bi-encoder model (`text-embedding-3-large` or a fine-tuned domain model)
3. **Indexing** — store vectors in a purpose-built store: Qdrant, Weaviate, or pgvector for SQL-first teams

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter
from openai import OpenAI

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1024,
    chunk_overlap=128,
    separators=["\n\n", "\n", ".", " "]
)

chunks = splitter.split_text(document)
client = OpenAI()

embeddings = client.embeddings.create(
    model="text-embedding-3-large",
    input=chunks
)
```

### 2. Retrieval layer

At query time, the user's question is embedded with the same model and used to retrieve the top-k most similar chunks. The retrieval step should return **both** dense vector matches (semantic) and BM25 keyword matches (lexical) — hybrid retrieval consistently outperforms either approach alone.

| Retrieval method | Strength | Weakness |
|---|---|---|
| Dense (vector) | Semantic understanding | Misses exact-match keywords |
| Sparse (BM25) | Exact keyword matching | No semantic reasoning |
| Hybrid (RRF fusion) | Best of both | Higher latency, complexity |

### 3. Generation

The retrieved chunks are injected into the LLM's context window as a structured prompt:

```
System: You are a technical assistant. Answer questions using only the provided context.
        If the answer is not in the context, say so clearly.

Context:
<chunk_1>...</chunk_1>
<chunk_2>...</chunk_2>

User: {question}
```

> The system prompt instruction to admit ignorance is non-negotiable in regulated domains. A hallucinated answer delivered confidently is worse than no answer at all.

## Evaluation framework

Measuring RAG quality requires decomposing into two independent axes:

- **Retrieval quality** — did the system surface the right chunks? Metrics: Recall@k, MRR, NDCG
- **Generation quality** — given the right context, did the model answer correctly? Metrics: faithfulness (RAGAS), answer relevance, context precision

```bash
# Install RAGAS evaluation library
pip install ragas

# Run evaluation against a test set
ragas evaluate \
  --dataset ./eval_set.json \
  --metrics faithfulness,answer_relevance,context_recall
```

## Production checklist

- [ ] Chunking strategy validated on your document corpus
- [ ] Embedding model benchmarked against domain-specific test set
- [ ] Hybrid retrieval (dense + sparse) implemented
- [ ] Re-ranker (cross-encoder) in place for top-k refinement
- [ ] Prompt template reviewed by domain expert
- [ ] Guardrails: system prompt enforces citation-only responses
- [ ] Evaluation pipeline automated in CI/CD
- [ ] Latency SLA defined: p95 < 2s is achievable with caching

## Key numbers

The difference between a production RAG system and a prototype is usually in the details of the retrieval layer. Teams that invest in hybrid retrieval and re-ranking see accuracy improvements of **18–34%** over naive vector-only baselines on enterprise document corpora.

---

## Further reading

- [RAGAS: Automated Evaluation of RAG Pipelines](https://docs.ragas.io) — the standard evaluation framework
- [Qdrant documentation](https://qdrant.tech/documentation) — vector store with built-in hybrid search
- [LangChain RAG How-To](https://python.langchain.com/docs/how_to/#qa-with-rag) — implementation guide
