import { NextRequest, NextResponse } from 'next/server';
import { getIndexes } from '@/lib/pinecone';
import openai from '@/lib/openai';

interface Document {
  id: string;
  content: string;
  metadata: {
    id: string;
    name: string;
    year: string;
    [key: string]: any;
  };
}



// Get embeddings from OpenAI
async function getEmbedding(text: string) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text,
  });
  return response.data[0].embedding;
}

// AI-powered query expansion
async function expandQuery(question: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a search query optimizer for Aaltoes (Aalto Entrepreneurship Society) document database.
Your task is to expand the user's search query to improve document retrieval.

Rules:
- Add relevant synonyms and related terms
- Include both formal and informal variations
- Add Finnish equivalents if relevant (Aaltoes is based in Finland)
- Keep the expanded query concise (max 100 words)
- Focus on business, entrepreneurship, and organizational terms
- Return ONLY the expanded query, no explanations

Example:
Input: "budget 2024"
Output: "budget 2024 finances financial plan spending expenses costs allocation money funding annual budget yearly budget talousarvio"`
        },
        {
          role: 'user',
          content: question
        }
      ],
      max_tokens: 150,
      temperature: 0.3,
    });

    const expandedQuery = response.choices[0]?.message?.content?.trim();
    if (expandedQuery) {
      console.log('Query expanded:', question, '->', expandedQuery);
      return expandedQuery;
    }
    return question;
  } catch (error) {
    console.error('Query expansion failed, using original:', error);
    return question;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question, selectedYears, selectedDataTypes, topK } = await request.json();
    // Always use private indexes for now (public indexes not available)
    const isPrivate = true;
    
    if (!question) {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    // Step 1: Use selected years from UI (no automatic extraction)
    const years = selectedYears || [];
    const searchTopK = topK || 50; // Default to 50 if not provided
    console.log('Selected years from UI:', years);
    console.log('TopK from UI:', searchTopK);
    
    // Step 2: Check if question is related to Aaltoes (more inclusive approach)
    const business_context_keywords = [
      'aaltoes', 'aalto', 'entrepreneurship', 'entrepreneur', 'startup', 'business', 
      'innovation', 'venture', 'company', 'founder', 'team', 'project', 'case',
      'strategy', 'market', 'product', 'service', 'customer', 'revenue', 'growth',
      'leadership', 'management', 'organization', 'community', 'network', 'event',
      'program', 'initiative', 'development', 'success', 'challenge', 'solution',
      'impact', 'ecosystem', 'culture', 'values', 'mission', 'vision', 'goal',
      'board', 'budget', 'decision', 'meeting', 'society', 'member', 'activity'
    ];
    
    // Clearly unrelated topics that should be filtered out
    const unrelated_keywords = [
      'weather', 'sports', 'cooking', 'recipe', 'movie', 'music', 'game', 
      'celebrity', 'politics', 'religion', 'medicine', 'health', 'personal',
      'travel', 'vacation', 'hobby', 'entertainment', 'fashion', 'shopping'
    ];
    
    const lowerQuestion = question.toLowerCase();
    const hasBusinessContext = business_context_keywords.some(keyword => lowerQuestion.includes(keyword));
    const hasUnrelatedContent = unrelated_keywords.some(keyword => lowerQuestion.includes(keyword));
    const questionWords = lowerQuestion.split(/\s+/).filter((word: string) => word.length > 2);
    const isReasonableLength = questionWords.length >= 2;
    
    // More inclusive: allow if it has business context OR if it's not clearly unrelated and reasonable length
    const isRelatedToAaltoes = (hasBusinessContext || (!hasUnrelatedContent && isReasonableLength));
    
    // Step 3: Preprocess question (replace aaltoes with Aaltoes)
    const processedQuestion = question.replace(/\baaltoes\b/gi, 'Aaltoes');
    
    // Step 4: Only search if question is related to Aaltoes
    let documents: Array<{id: string; name: string; year: string; score: number; numQuestions: number; link: string | null}> = [];
    let allChunks: Document[] = [];
    let summaryResults: any = null;
    
    if (isRelatedToAaltoes) {
      // Step 4a: Get appropriate indexes based on private access
      const { summaryIndex, chunkIndex, questionsIndex } = getIndexes(isPrivate);
      console.log('Using indexes for private access:', isPrivate);
      
      // Step 4b: Get embedding for the question
      const questionEmbedding = await getEmbedding(processedQuestion);
      
      // Step 4c: Search both summaries and questions indexes for comprehensive results
      console.log('Searching summaries and questions indexes');
      
      // Build filters for metadata queries
      const dataTypes = selectedDataTypes || [];
      const yearFilter = years.length > 0 ? { year: { $in: years } } : undefined;
      
      console.log('Selected data types:', dataTypes);
      console.log('Year filter:', yearFilter);
      
      // Build data type filter
      let dataTypeFilter = undefined;
      if (dataTypes.length > 0 && !dataTypes.includes('all')) {
        if (dataTypes.includes('documents') && dataTypes.includes('excel')) {
          // Both selected - no filter needed
          dataTypeFilter = undefined;
          console.log('Both documents and excel selected - no filter');
        } else if (dataTypes.includes('documents')) {
          dataTypeFilter = { 
            $and: [
              { mimeType: { $ne: 'application/vnd.google-apps.spreadsheet' } },
              { mimeType: { $ne: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }
            ]
          };
          console.log('Documents only filter:', dataTypeFilter);
        } else if (dataTypes.includes('excel')) {
          dataTypeFilter = { 
            $or: [
              { mimeType: 'application/vnd.google-apps.spreadsheet' },
              { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            ]
          };
          console.log('Excel only filter:', dataTypeFilter);
        }
      } else {
        console.log('No data type filtering (all or empty)');
      }
      
      // Combine filters
      const combinedFilter = (() => {
        if (yearFilter && dataTypeFilter) {
          return { $and: [yearFilter, dataTypeFilter] };
        } else if (yearFilter) {
          return yearFilter;
        } else if (dataTypeFilter) {
          return dataTypeFilter;
        } else {
          return undefined;
        }
      })();
      
      console.log('Combined filter for Pinecone query:', JSON.stringify(combinedFilter, null, 2));

      const [summaryResults, questionResults, chunkSearchResults] = await Promise.all([
        // Search summaries with combined filter
        summaryIndex.query({
          vector: questionEmbedding,
          topK: searchTopK,
          includeMetadata: true,
          filter: combinedFilter,
        }).catch((error: any) => {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        }),
        // Search questions with combined filter
        questionsIndex.query({
          vector: questionEmbedding,
          topK: searchTopK,
          includeMetadata: true,
          filter: combinedFilter,
        }).catch((error: any) => {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        }),
        // Search chunks directly for content that might not be in summaries/questions (e.g., names, specific details)
        chunkIndex.query({
          vector: questionEmbedding,
          topK: searchTopK * 2, // Search more chunks to find diverse documents
          includeMetadata: true,
          filter: combinedFilter,
        }).catch((error: any) => {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        })
      ]);

      console.log('Summary results count:', summaryResults.matches?.length);
      console.log('Question results count:', questionResults.matches?.length);
      console.log('Direct chunk search results count:', chunkSearchResults.matches?.length);
      
      // Debug: Show some example results to verify filter is working
      if (summaryResults.matches?.length > 0) {
        console.log('Sample summary results:');
        summaryResults.matches.slice(0, 3).forEach((match: any, i: number) => {
          console.log(`  ${i+1}. ${match.metadata?.name} - mimeType: ${match.metadata?.mimeType}`);
        });
      }
      
      if (questionResults.matches?.length > 0) {
        console.log('Sample question results:');
        questionResults.matches.slice(0, 3).forEach((match: any, i: number) => {
          console.log(`  ${i+1}. ${match.metadata?.name} - mimeType: ${match.metadata?.mimeType}`);
        });
      }

      // Step 5: Create hybrid document ranking combining summaries, questions, and direct chunk matches
      const processedSummaries = summaryResults.matches || [];
      const processedQuestions = questionResults.matches || [];
      const processedChunks = chunkSearchResults.matches || [];

      // Create hybrid scoring: combine summary, question, and chunk relevance
      const documentScores = new Map<string, {summary: number, question: number, chunk: number, metadata: any}>();

      // Add summary scores (summaries use "id" field)
      console.log('Processing summaries:', processedSummaries.length);
      processedSummaries.forEach((match: any) => {
        const docId = match.metadata?.id; // Summaries use "id"
        if (docId) {
          documentScores.set(docId, {
            summary: match.score || 0,
            question: 0,
            chunk: 0,
            metadata: match.metadata
          });
        }
      });

      // Add question scores (questions use "doc_id" field)
      console.log('Processing questions:', processedQuestions.length);
      processedQuestions.forEach((match: any) => {
        const docId = match.metadata?.doc_id; // Questions use "doc_id"
        if (docId && documentScores.has(docId)) {
          const existing = documentScores.get(docId)!;
          existing.question = Math.max(existing.question, match.score || 0);
        } else if (docId) {
          documentScores.set(docId, {
            summary: 0,
            question: match.score || 0,
            chunk: 0,
            metadata: match.metadata
          });
        }
      });

      // Add chunk scores (chunks use "doc_id" field) - this catches content like names that might not be in summaries
      console.log('Processing direct chunk matches:', processedChunks.length);
      processedChunks.forEach((match: any) => {
        const docId = match.metadata?.doc_id || match.metadata?.id;
        if (docId && documentScores.has(docId)) {
          const existing = documentScores.get(docId)!;
          // Keep the highest chunk score for this document
          existing.chunk = Math.max(existing.chunk, match.score || 0);
        } else if (docId) {
          // Document found via chunk search but not in summaries/questions - important for specific content like names
          documentScores.set(docId, {
            summary: 0,
            question: 0,
            chunk: match.score || 0,
            metadata: match.metadata
          });
          console.log(`Added new doc ${docId} from chunk search (content match)`);
        }
      });

      console.log('Total unique documents after combining all sources:', documentScores.size);

      // Calculate hybrid scores (weighted combination with boost for multi-index matches)
      const hybridDocuments = Array.from(documentScores.entries()).map(([docId, scores]) => {
        const sourceCount = (scores.summary > 0 ? 1 : 0) + (scores.question > 0 ? 1 : 0) + (scores.chunk > 0 ? 1 : 0);
        // Base hybrid score: weighted combination of all three sources
        // Chunk gets high weight because it directly matches content (like names)
        let hybridScore = (scores.summary * 0.3) + (scores.question * 0.3) + (scores.chunk * 0.4);
        // Boost documents that appear in multiple indexes (higher confidence)
        if (sourceCount >= 2) {
          hybridScore *= 1.1 + (sourceCount * 0.1); // 1.2x for 2 sources, 1.3x for 3 sources
        }
        return {
          docId,
          summaryScore: scores.summary,
          questionScore: scores.question,
          chunkScore: scores.chunk,
          hybridScore,
          metadata: scores.metadata
        };
      }).sort((a, b) => b.hybridScore - a.hybridScore).slice(0, searchTopK);

      console.log('Top hybrid documents:',
        hybridDocuments.slice(0, 5).map((doc: any) => ({
          name: doc.metadata?.name,
          summaryScore: doc.summaryScore.toFixed(3),
          questionScore: doc.questionScore.toFixed(3),
          chunkScore: doc.chunkScore.toFixed(3),
          hybridScore: doc.hybridScore.toFixed(3),
          year: doc.metadata?.year
        }))
      );

      // Get document IDs from hybrid ranking
      let docIds = hybridDocuments.map(doc => doc.docId);

      // Fallback: if hybrid approach yields no results, use chunk search results directly
      if (docIds.length === 0 && processedChunks.length > 0) {
        console.log('Hybrid approach yielded no results, falling back to chunk search');
        const uniqueDocIds = new Set<string>();
        processedChunks.forEach((match: any) => {
          const docId = match.metadata?.doc_id || match.metadata?.id;
          if (docId) uniqueDocIds.add(docId);
        });
        docIds = Array.from(uniqueDocIds);
      }

      console.log('Processing documents from hybrid ranking:', docIds.length);

      console.log(`Getting chunks for ${docIds.length} documents`);
      
      for (const docId of docIds) {
        console.log(`Searching chunks for document: ${docId}`);

        // Search chunks (chunks use "doc_id" field to reference parent document)
        let chunkResults;
        try {
          // Build filter for this specific document's chunks
          const docFilter = { doc_id: docId };
          const chunkFilter = combinedFilter
            ? { $and: [docFilter, combinedFilter] }
            : docFilter;
          chunkResults = await chunkIndex.query({
            vector: questionEmbedding,
            topK: 3, // Get top 3 chunks per document, then pick best
            includeMetadata: true,
            filter: chunkFilter,
          });
        } catch (error: any) {
          if (error.message?.includes('404') || error.message?.includes('not found')) {
            if (isPrivate) {
              throw new Error('Private document access is not implemented yet. Please contact administrator to set up private indexes.');
            } else {
              throw new Error('Public version is not available yet, we work hard to filter our files for you. You can request access to private version at board@aaltoes.com');
            }
          }
          throw error;
        }
        
        console.log(`Chunk results for ${docId}:`, chunkResults.matches?.length || 0);
        
        // If no results with doc_id filter, skip this document (don't use unrelated chunks)
        if (!chunkResults.matches?.length) {
          console.log(`No chunks found for document ${docId}, skipping`);
          continue;
        }
        
        console.log(`Final chunk results for ${docId}:`, chunkResults.matches?.length || 0);
        
        const chunks = chunkResults.matches?.map(match => ({
          id: match.id || '',
          content: String(match.metadata?.text || ''),
          score: match.score || 0,
          metadata: {
            id: String(match.metadata?.doc_id || match.metadata?.id || ''),
            name: String(match.metadata?.name || 'Untitled'),
            year: String(match.metadata?.year || 'unknown'),
            link: match.metadata?.url || 
                  match.metadata?.google_drive_link || 
                  match.metadata?.drive_link || 
                  match.metadata?.link || 
                  null,
            ...match.metadata,
          }
        })).filter(chunk => chunk.content)
          .sort((a, b) => b.score - a.score) // Sort by relevance score
          .slice(0, 1) || []; // Take only the best chunk from this document
        
        console.log(`Processed chunks for ${docId}:`, chunks.length);
        allChunks.push(...chunks);
      }

      console.log('Total chunks collected:', allChunks.length);

      // Step 8: Final diversification - ensure we have chunks from multiple documents
      const chunksByDocument = allChunks.reduce((acc, chunk) => {
        const docId = chunk.metadata.id;
        if (!acc[docId]) acc[docId] = [];
        acc[docId].push(chunk);
        return acc;
      }, {} as Record<string, typeof allChunks>);

      // Interleave chunks from different documents to ensure diversity
      const diversifiedChunks = [];
      const documentIds = Object.keys(chunksByDocument);
      let maxRounds = Math.max(...Object.values(chunksByDocument).map(chunks => chunks.length));
      
      for (let round = 0; round < maxRounds && diversifiedChunks.length < searchTopK; round++) {
        for (const docId of documentIds) {
          if (chunksByDocument[docId][round] && diversifiedChunks.length < searchTopK) {
            diversifiedChunks.push(chunksByDocument[docId][round]);
          }
        }
      }

      allChunks = diversifiedChunks;
      
      console.log('Chunks distribution:', 
        Object.entries(chunksByDocument).map(([docId, chunks]) => ({
          document: chunks[0]?.metadata.name || docId,
          chunkCount: chunks.length,
          scores: chunks.map((c: any) => c.score.toFixed(3))
        }))
      );

      // Step 7: Prepare response data using hybrid-ranked documents or fallback to summaries
      let documentsBeforeYearFilter: any[] = [];
      
      if (hybridDocuments.length > 0) {
        // Use hybrid results
        documentsBeforeYearFilter = hybridDocuments.map((hybridDoc: any) => ({
          id: hybridDoc.docId || '',
          name: hybridDoc.metadata?.name || 'Untitled',
          year: hybridDoc.metadata?.year ? String(hybridDoc.metadata.year) : 'unknown',
          score: hybridDoc.hybridScore || 0, // Hybrid similarity score
          summaryScore: hybridDoc.summaryScore || 0,
          questionScore: hybridDoc.questionScore || 0,
          chunkScore: hybridDoc.chunkScore || 0,
          numQuestions: hybridDoc.metadata?.num_questions || 0,
          // Extract links from new structure
          link: hybridDoc.metadata?.url ||
                hybridDoc.metadata?.google_drive_link ||
                hybridDoc.metadata?.drive_link ||
                hybridDoc.metadata?.link ||
                null,
        }));
      } else if (processedChunks.length > 0) {
        // Fallback to chunk search results (catches names and specific content)
        console.log('Using chunk search fallback for document preparation');
        const seenDocIds = new Set<string>();
        documentsBeforeYearFilter = processedChunks
          .filter((match: any) => {
            const docId = match.metadata?.doc_id || match.metadata?.id;
            if (!docId || seenDocIds.has(docId)) return false;
            seenDocIds.add(docId);
            return true;
          })
          .map((match: any) => ({
            id: match.metadata?.doc_id || match.metadata?.id || '',
            name: match.metadata?.name || 'Untitled',
            year: match.metadata?.year ? String(match.metadata.year) : 'unknown',
            score: match.score || 0,
            summaryScore: 0,
            questionScore: 0,
            chunkScore: match.score || 0,
            numQuestions: match.metadata?.num_questions || 0,
            link: match.metadata?.url ||
                  match.metadata?.google_drive_link ||
                  match.metadata?.drive_link ||
                  match.metadata?.link ||
                  null,
          }));
      }

      console.log('Documents before year filtering:', documentsBeforeYearFilter.map((d: any) => ({ 
        name: d.name, 
        year: d.year, 
        score: d.score.toFixed(3) 
      })));

      // Year filtering already applied at Pinecone query level
      documents = documentsBeforeYearFilter;
      console.log('Documents after Pinecone year filtering:', documents.length);

      console.log('Documents with question similarity:', documents.map(d => ({ 
        name: d.name, 
        year: d.year, 
        score: d.score,
        numQuestions: d.numQuestions,
        hasLink: !!d.link 
      })));
    } else {
      console.log('Question not related to Aaltoes, skipping document search');
      // Return early with empty results for unrelated questions
      return NextResponse.json({
        years: [],
        documents: [],
        chunks: [],
        question: processedQuestion,
        isRelated: false,
      });
    }

    // Step 9: Get only unique sources from chunks (documents actually used) and sort by question similarity
    const usedDocuments = documents.length > 0 ? Array.from(new Set(
      allChunks.map(chunk => chunk.metadata.id)
    )).map(docId => {
      // Find the question-matched document that matches this chunk's document ID
      const questionDoc = documents.find(doc => doc.id === docId);
      return questionDoc ? {
        id: String(questionDoc.id || ''),
        name: String(questionDoc.name || 'Untitled'),
        year: String(questionDoc.year || 'unknown'),
        score: questionDoc.score || 0, // Use question similarity score
        numQuestions: questionDoc.numQuestions || 0,
        link: questionDoc.link,
      } : null;
    }).filter(Boolean)
      .sort((a: any, b: any) => (b?.score || 0) - (a?.score || 0)) : []; // Sort by question similarity score

    // Step 10: Filter chunks to only include those from documents that will be displayed
    const displayedDocumentIds = new Set(usedDocuments.map(doc => doc?.id));
    const filteredChunks = allChunks.filter(chunk => 
      displayedDocumentIds.has(chunk.metadata.id)
    );

    console.log('Used documents (displayed to user):', usedDocuments.map(d => ({ 
      name: d?.name, 
      year: d?.year, 
      score: d?.score,
      numQuestions: d?.numQuestions,
      hasLink: !!d?.link 
    })));

    console.log('Chunks sent to LLM:', filteredChunks.length, 'from', displayedDocumentIds.size, 'displayed documents');

    return NextResponse.json({
      years,
      documents: usedDocuments,
      chunks: filteredChunks, // Only chunks from displayed documents
      question: processedQuestion,
      isRelated: true,
    });

  } catch (error: any) {
    console.error('Search error:', error);
    
    // Check if this is our custom availability error (public or private)
    if (error.message?.includes('not implemented yet') || error.message?.includes('not available yet')) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
