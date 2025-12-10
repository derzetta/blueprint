'use client';

import { useState, useRef, useEffect, memo } from 'react';
import { Search, FileText, Calendar, ExternalLink, Loader2, X, Sun, Moon, Square } from 'lucide-react';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useTheme } from '@/components/theme-provider';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Document {
  id: string;
  name: string;
  year: string;
  score: number;
  numQuestions?: number;
  link?: string;
}

interface SearchResponse {
  years: string[];
  documents: Document[];
  chunks: any[];
  question: string;
}

interface DocumentDetails {
  id: string;
  name: string;
  summary: string;
  questions: string[];
}

// Animated response component with line-by-line reveal - memoized to prevent re-animation on typing
const AnimatedResponse = memo(function AnimatedResponse({ content, animationKey }: { content: string; animationKey: number }) {
  let lineIndex = 0;
  const getLineDelay = () => {
    const delay = lineIndex * 80;
    lineIndex++;
    return delay;
  };

  return (
    <ReactMarkdown
      key={animationKey}
      className="text-base leading-8 text-foreground"
      components={{
        h1: ({ children }) => <h1 className="text-2xl font-semibold mb-4 mt-8 first:mt-0 text-foreground tracking-tight animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-semibold mb-3 mt-6 first:mt-0 text-foreground tracking-tight animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-medium mb-2 mt-5 first:mt-0 text-foreground animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</h3>,
        p: ({ children }) => <p className="mb-4 last:mb-0 text-pretty text-foreground/90 animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</p>,
        ul: ({ children }) => <ul className="mb-4 pl-6 space-y-2 list-disc marker:text-foreground/40 animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</ul>,
        ol: ({ children }) => <ol className="mb-4 pl-6 space-y-2 list-decimal marker:text-foreground/40 animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</ol>,
        li: ({ children }) => <li className="text-base leading-8 pl-1 text-foreground/90">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
        code: ({ children }) => <code className="bg-secondary text-foreground px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>,
        pre: ({ children }) => <pre className="bg-secondary border border-border rounded-lg p-4 text-sm overflow-x-auto mb-4 font-mono animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</pre>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-foreground/20 pl-4 my-4 italic text-foreground/70 animate-line-reveal" style={{ '--line-delay': `${getLineDelay()}ms` } as React.CSSProperties}>{children}</blockquote>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline decoration-foreground/30 hover:decoration-foreground/60 underline-offset-2 transition-colors inline-flex items-center gap-1 font-medium"
          >
            {children}
            <ExternalLink className="w-3.5 h-3.5 inline flex-shrink-0 opacity-50" />
          </a>
        ),
        hr: () => <hr className="my-6 border-border" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export default function Home() {
  const { data: session, status } = useSession();
  const { theme, setTheme } = useTheme();
  const [question, setQuestion] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [streamedResponse, setStreamedResponse] = useState('');
  const [searchData, setSearchData] = useState<SearchResponse | null>(null);
  const [documentDetails, setDocumentDetails] = useState<DocumentDetails | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [animationKey, setAnimationKey] = useState(0);
  const [finalResponse, setFinalResponse] = useState('');
  const [selectedYears, setSelectedYears] = useState<string[]>([]);
  const [selectedDataTypes, setSelectedDataTypes] = useState<string[]>([]);
  const [topK, setTopK] = useState<number>(25);
  const [isPrivate, setIsPrivate] = useState<boolean>(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAvailabilityModal, setShowAvailabilityModal] = useState(false);
  const [availabilityType, setAvailabilityType] = useState<'public' | 'private'>('public');
  const responseRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load saved settings from localStorage on mount
  useEffect(() => {
    const savedTopK = localStorage.getItem('blueprint-topk');
    const savedIsPrivate = localStorage.getItem('blueprint-private');

    if (savedTopK && topKOptions.includes(parseInt(savedTopK))) {
      setTopK(parseInt(savedTopK));
    }
    
    if (savedIsPrivate !== null && savedIsPrivate !== undefined) {
      setIsPrivate(savedIsPrivate === 'true');
    }

    // Clean up any previously saved years data
    localStorage.removeItem('blueprint-selected-years');
  }, []);

  // Reset to public mode if user loses admin privileges while in private mode
  useEffect(() => {
    if (isPrivate && session?.user?.role !== 'ADMIN') {
      updateIsPrivate(false);
    }
  }, [session?.user?.role, isPrivate]);

  // Default to private for admins if no saved preference exists yet
  useEffect(() => {
    if (!session) return;
    const savedIsPrivate = localStorage.getItem('blueprint-private');
    if (session.user?.role === 'ADMIN' && (savedIsPrivate === null || savedIsPrivate === undefined)) {
      updateIsPrivate(true);
      localStorage.setItem('blueprint-private', 'true');
    }
  }, [session?.user?.role]);

  // Available years in the database
  const availableYears = ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
  
  // Available data types
  const availableDataTypes = [
    { value: 'documents', label: 'Documents' },
    { value: 'excel', label: 'Spreadsheets' },
    { value: 'all', label: 'All Types' }
  ];
  
  // Available topK options
  const topKOptions = [10, 25, 50, 100];

  // Wrapper functions to save to localStorage
  const updateTopK = (newTopK: number) => {
    setTopK(newTopK);
    localStorage.setItem('blueprint-topk', newTopK.toString());
  };

  const updateIsPrivate = (newIsPrivate: boolean) => {
    setIsPrivate(newIsPrivate);
    localStorage.setItem('blueprint-private', newIsPrivate.toString());
  };

  // Toggle year selection
  const toggleYear = (year: string) => {
    setSelectedYears(prev => 
      prev.includes(year) 
        ? prev.filter(y => y !== year)
        : [...prev, year]
    );
  };



  // Auto-scroll to bottom of response as it streams
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [streamedResponse]);

  // Fetch document details (summary and questions)
  const fetchDocumentDetails = async (docId: string) => {
    setIsLoadingDetails(true);
    try {
      const response = await fetch('/api/document-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, isPrivate }),
      });

      if (!response.ok) {
        throw new Error('Failed to fetch document details');
      }

      const details = await response.json();
      setDocumentDetails(details);
    } catch (error) {
      console.error('Error fetching document details:', error);
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const handleSearch = async () => {
    if (!question.trim()) return;

    // Check if user is logged in
    if (!session) {
      setShowLoginModal(true);
      return;
    }

    // Check if user is trying to access private mode without admin privileges
    if (isPrivate && session?.user?.role !== 'ADMIN') {
      // Reset to public mode and show availability dialog
      updateIsPrivate(false);
      setAvailabilityType('private');
      setShowAvailabilityModal(true);
      return;
    }

    // Prevent new searches while one is in progress
    if (isSearching || isStreaming) {
      return;
    }

    setIsSearching(true);
    setDocuments([]);
    setStreamedResponse('');
    setFinalResponse('');
    setSearchData(null);
    setSubmittedQuestion(question.trim());
    setAnimationKey(prev => prev + 1);

    // Create abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Step 1: Search for relevant documents
      // Always use private indexes for now (public indexes not available)
      const searchResponse = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, selectedYears, selectedDataTypes, topK, isPrivate: true }),
        signal: abortController.signal,
      });

      const searchResult = await searchResponse.json();
      
      if (!searchResponse.ok) {
        // Check if this is any availability message (public or private)
        const errorMessage = searchResult.error || 'Search failed';
        if (errorMessage.includes('not available yet')) {
          setAvailabilityType('public');
          setShowAvailabilityModal(true);
          return;
        } else if (errorMessage.includes('not implemented yet')) {
          setAvailabilityType('private');
          setShowAvailabilityModal(true);
          return;
        }
        // For other errors, show the error message
        setStreamedResponse(errorMessage);
        return;
      }
      setDocuments(searchResult.documents);
      setSearchData(searchResult);
      setIsSearching(false);

      // Step 2: Stream the LLM response (collect in background, show when done)
      if (searchResult.chunks.length > 0) {
        setIsStreaming(true);

        const chatResponse = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: searchResult.question,
            chunks: searchResult.chunks
          }),
          signal: abortController.signal,
        });

        if (!chatResponse.ok) {
          throw new Error('Chat failed');
        }

        const reader = chatResponse.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let buffer = '';
          let fullResponse = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  // Set final response with animation when complete
                  setFinalResponse(fullResponse);
                  setIsStreaming(false);
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content) {
                    fullResponse += parsed.content;
                    // Show progress indicator while streaming
                    setStreamedResponse(fullResponse);
                  }
                } catch (e) {
                  // Skip invalid JSON
                }
              }
            }
          }
          // If we exit the loop without [DONE], still set the response
          if (fullResponse) {
            setFinalResponse(fullResponse);
          }
        }
      } else {
        setFinalResponse('I could not find any documents related to your question.');
      }
    } catch (error: any) {
      console.error('Error:', error);
      if (error.name === 'AbortError') {
        // Don't replace content on abort, user already stopped it manually
        console.log('Search was cancelled by user');
      } else {
        setFinalResponse('An error occurred while processing your question.');
      }
    } finally {
      setIsSearching(false);
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsSearching(false);
      setIsStreaming(false);
      // Don't replace the content, just append a note that it was stopped
      setStreamedResponse(prev => prev + '\n\n*[Search stopped by user]*');
      abortControllerRef.current = null;
    }
  };

  if (status === "loading") {
    return (
      <main className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Compact Header Bar */}
      <div className="w-full bg-background pt-8 lg:pt-12 pb-4">
        <div className="max-w-6xl mx-auto px-4 lg:px-6">
          <div className="flex items-center justify-between h-10">
            {/* Logo - Left side */}
            <div className="flex items-center gap-4">
              <img
                src={theme === 'dark' ? "https://www.aaltoes.com/bank/aaltoes_white.svg" : "https://www.aaltoes.com/bank/aaltoes_dark.svg"}
                alt="Aaltoes"
                className="h-6"
              />
              <div className="h-5 w-px bg-border" />
              <h1 className="text-base font-normal text-foreground font-mono tracking-wider">
                BLUEPRINT
              </h1>
            </div>

            {/* Center: Private/Public Toggle */}
            <div className="hidden sm:flex absolute left-1/2 transform -translate-x-1/2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="inline-flex rounded-full border border-border bg-secondary/30 p-0.5">
                      <button
                        className={`px-3 py-1.5 text-sm font-medium rounded-full transition-all ${
                          !isPrivate
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-foreground/50 hover:text-foreground'
                        } ${session?.user?.role !== 'ADMIN' ? 'cursor-default' : 'cursor-pointer'}`}
                        onClick={() => session?.user?.role === 'ADMIN' && updateIsPrivate(false)}
                        disabled={session?.user?.role !== 'ADMIN'}
                      >
                        Public
                      </button>
                      <button
                        className={`px-3 py-1.5 text-sm font-medium rounded-full transition-all ${
                          isPrivate
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-foreground/50 hover:text-foreground'
                        } ${session?.user?.role !== 'ADMIN' ? 'cursor-default' : 'cursor-pointer'}`}
                        onClick={() => session?.user?.role === 'ADMIN' && updateIsPrivate(true)}
                        disabled={session?.user?.role !== 'ADMIN'}
                      >
                        Private
                      </button>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="text-xs">
                      Private documents are available only for the board.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            {/* Right side: Theme + Auth */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 rounded-full text-foreground/50 hover:text-foreground hover:bg-secondary"
                onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? (
                  <Moon className="w-5 h-5" />
                ) : (
                  <Sun className="w-5 h-5" />
                )}
              </Button>

              {session ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 px-4 text-sm font-medium rounded-full text-foreground/70 hover:text-foreground hover:bg-secondary"
                  onClick={() => signOut()}
                >
                  Logout
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  className="h-9 px-4 text-sm font-medium rounded-full"
                  onClick={() => signIn('google')}
                >
                  Login
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content Container */}
      <div className="max-w-6xl mx-auto w-full px-4 lg:px-6 py-3 flex flex-col overflow-hidden flex-1">

        {/* Results Container - Takes remaining height */}
        {(submittedQuestion && (isSearching || isStreaming || finalResponse || documents.length > 0)) && (
          <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:gap-6 min-h-0 overflow-hidden">
            {/* Left column - Question + Response */}
            <div className="flex-[2] min-h-0 flex flex-col">
              {/* Question Heading - Perplexity style */}
              <div className="flex-shrink-0 mb-4">
                <h1
                  key={animationKey}
                  className={`text-2xl lg:text-3xl font-semibold tracking-tight leading-tight animate-pullup-blur ${
                    isSearching || isStreaming ? 'thinking-gradient' : 'text-foreground'
                  }`}
                >
                  {submittedQuestion}
                </h1>

                {/* Progress roadmap */}
                {(isSearching || isStreaming) && (
                  <div className="flex items-center gap-3 mt-4 animate-fade-in">
                    {/* Step 1: Searching */}
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        {/* Pulse ring for active step */}
                        {isSearching && !searchData && (
                          <div className="absolute inset-0 rounded-full bg-foreground/30 animate-ping" />
                        )}
                        <div className={`relative w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-300 ${
                          isSearching && !searchData
                            ? 'bg-foreground text-background'
                            : searchData
                              ? 'bg-foreground/20 text-foreground/60'
                              : 'bg-foreground/10 text-foreground/30'
                        }`}>
                          {searchData ? (
                            <Check className="w-3 h-3" />
                          ) : (
                            <span>1</span>
                          )}
                        </div>
                      </div>
                      <span className={`text-sm transition-all duration-300 ${
                        isSearching && !searchData ? 'text-foreground font-medium' : 'text-foreground/40'
                      }`}>
                        Search
                      </span>
                    </div>

                    {/* Connector 1 */}
                    <div className="w-8 h-px bg-foreground/10 relative overflow-hidden">
                      <div className={`absolute inset-y-0 left-0 bg-foreground/40 transition-all duration-500 ${
                        searchData ? 'w-full' : 'w-0'
                      }`} />
                    </div>

                    {/* Step 2: Analyzing */}
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        {/* Pulse ring for active step */}
                        {searchData && !streamedResponse && (
                          <div className="absolute inset-0 rounded-full bg-foreground/30 animate-ping" />
                        )}
                        <div className={`relative w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-300 ${
                          searchData && !streamedResponse
                            ? 'bg-foreground text-background'
                            : streamedResponse
                              ? 'bg-foreground/20 text-foreground/60'
                              : 'bg-foreground/10 text-foreground/30'
                        }`}>
                          {streamedResponse ? (
                            <Check className="w-3 h-3" />
                          ) : (
                            <span>2</span>
                          )}
                        </div>
                      </div>
                      <span className={`text-sm transition-all duration-300 ${
                        searchData && !streamedResponse ? 'text-foreground font-medium' : 'text-foreground/40'
                      }`}>
                        Analyze
                      </span>
                    </div>

                    {/* Connector 2 */}
                    <div className="w-8 h-px bg-foreground/10 relative overflow-hidden">
                      <div className={`absolute inset-y-0 left-0 bg-foreground/40 transition-all duration-500 ${
                        streamedResponse ? 'w-full' : 'w-0'
                      }`} />
                    </div>

                    {/* Step 3: Generating */}
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        {/* Pulse ring for active step */}
                        {isStreaming && streamedResponse && (
                          <div className="absolute inset-0 rounded-full bg-foreground/30 animate-ping" />
                        )}
                        <div className={`relative w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-300 ${
                          isStreaming && streamedResponse
                            ? 'bg-foreground text-background'
                            : !isStreaming && streamedResponse
                              ? 'bg-foreground/20 text-foreground/60'
                              : 'bg-foreground/10 text-foreground/30'
                        }`}>
                          {!isStreaming && streamedResponse ? (
                            <Check className="w-3 h-3" />
                          ) : (
                            <span>3</span>
                          )}
                        </div>
                      </div>
                      <span className={`text-sm transition-all duration-300 ${
                        isStreaming && streamedResponse ? 'text-foreground font-medium' : 'text-foreground/40'
                      }`}>
                        Generate
                      </span>
                    </div>
                  </div>
                )}

                {/* Years detected */}
                {searchData?.years && searchData.years.length > 0 && !isSearching && !isStreaming && (
                  <div className="mt-3 animate-fade-in">
                    <Badge variant="secondary" className="gap-1.5 text-xs">
                      <Calendar className="w-3 h-3" />
                      {searchData.years.join(', ')}
                    </Badge>
                  </div>
                )}
              </div>

              {/* AI Response */}
              {finalResponse && (
                <div className="flex-1 min-h-0 mt-6">
                  <div
                    ref={responseRef}
                    className="overflow-y-auto h-full"
                  >
                    <AnimatedResponse content={finalResponse} animationKey={animationKey} />
                  </div>
                </div>
              )}
            </div>

            {/* Documents Sidebar - Right on desktop, bottom on mobile */}
            {documents.length > 0 && (
              <div key={animationKey} className="flex-1 lg:w-80 lg:flex-shrink-0 min-w-0 min-h-0 flex flex-col">
                <Card className="h-full flex flex-col border-border shadow-sm animate-card-appear">
                  <CardHeader className="pb-3 flex-shrink-0 border-b border-border">
                    <CardTitle className="text-sm font-medium flex items-center gap-2 text-foreground/70">
                      <FileText className="w-4 h-4" />
                      Sources ({documents.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-y-auto overflow-x-hidden pt-3 flex-1">
                    <div className="grid grid-cols-2 lg:grid-cols-1 gap-2">
                      {documents.map((doc, index) => (
                        <div
                          key={doc.id || index}
                          className="p-2.5 rounded-lg border border-border bg-secondary/50 hover:bg-secondary transition-colors animate-card-appear"
                          style={{ animationDelay: `${150 + index * 60}ms` }}
                        >
                        <div className="space-y-1.5 min-w-0">
                          <h3 className="font-medium text-xs leading-tight break-words text-foreground/90">
                            {doc.name}
                          </h3>
                          <div className="flex items-center gap-1.5 text-[11px] text-foreground/50">
                            <Calendar className="w-3 h-3" />
                            <span>{doc.year}</span>
                            <Badge variant="secondary" className="text-[10px] h-4 px-1 font-mono">
                              {(doc.score * 100).toFixed(0)}%
                            </Badge>
                          </div>
                          <div className="flex gap-2 pt-1">
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-auto px-2 py-1 text-xs font-mono"
                                  onClick={() => fetchDocumentDetails(doc.id)}
                                >
                            <FileText className="w-3 h-3 mr-1" />
                                  View
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-w-4xl w-[90vw] h-[85vh] flex flex-col">
                                <DialogHeader className="flex-shrink-0 pb-4 border-b">
                                  <DialogTitle className="text-xl font-semibold pr-8">
                                    {documentDetails?.name || doc.name}
                                  </DialogTitle>
                                  <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                                    <Calendar className="w-4 h-4" />
                                    <span>{doc.year}</span>
                                    <Badge variant="outline" className="text-xs">
                                      {(doc.score * 100).toFixed(0)}% match
                                    </Badge>

                                  </div>
                                </DialogHeader>
                                
                                <div className="flex-1 overflow-hidden">
                                  {isLoadingDetails ? (
                                    <div className="flex items-center justify-center h-full">
                                      <div className="text-center">
                                        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
                                        <p className="text-sm text-muted-foreground">Loading document details...</p>
                                      </div>
                                    </div>
                                  ) : documentDetails ? (
                                    <div className="h-full overflow-y-auto">
                                      <div className="p-6 space-y-8">
                                        {/* Summary Section */}
                                        <div>
                                          <div className="flex items-center gap-2 mb-4">
                                            <FileText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                                            <h3 className="text-lg font-medium">Document Summary</h3>
                                          </div>
                                          <div className="rounded-lg p-6 border bg-gray-100 dark:bg-gray-900 border-gray-200 dark:border-gray-800">
                                            <p className="text-sm leading-relaxed text-foreground">
                                              {documentDetails.summary}
                                            </p>
                                          </div>
                                        </div>
                                        
                                        {/* Questions Section */}
                                        <div>
                                          <div className="flex items-center gap-2 mb-4">
                                            <Search className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                                            <h3 className="text-lg font-medium">
                                              Questions Answered ({documentDetails.questions.length})
                                            </h3>
                                          </div>
                                          <div className="grid gap-3">
                                            {documentDetails.questions.map((question, idx) => (
                                              <div 
                                                key={idx}
                                                className="bg-card border rounded-lg p-4"
                                              >
                                                <p className="text-sm leading-relaxed">
                                                  {question}
                                                </p>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-center h-full">
                                      <div className="text-center">
                                        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-3">
                                          <ExternalLink className="w-6 h-6 text-destructive" />
                                        </div>
                                        <p className="text-sm text-muted-foreground">Failed to load document details</p>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </DialogContent>
                            </Dialog>
                            
                            {doc.link && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto px-2 py-1 text-xs font-mono"
                                asChild
                              >
                                <a
                                  href={doc.link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Open
                                </a>
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}



        {/* Empty State */}
        {!isSearching && !documents.length && !streamedResponse && (
          <div className="flex-1 flex items-center justify-center animate-fade-in">
            <div className="text-center">
              <p className="text-foreground/40 text-lg">
                {session ? `Hi ${session.user?.name?.split(' ')[0] || 'there'}, ` : ''}Ask a question about Aaltoes to get started
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Login Required Modal */}
      <Dialog open={showLoginModal} onOpenChange={setShowLoginModal}>
        <DialogContent className="sm:max-w-sm border-border bg-background">
          <div className="text-center pt-2 pb-4">
            <h2 className="text-base font-semibold text-foreground tracking-tight mb-6">
              BLUEPRINT
            </h2>
            <p className="text-foreground/60 text-base leading-relaxed mb-2">
              Provides access to Aaltoes knowledge base.
            </p>
            <p className="text-foreground/60 text-base mb-8">
              Exclusively for Aaltoes members.
            </p>
            <div className="flex gap-3 justify-center">
              <Button
                variant="outline"
                className="h-10 px-5 text-sm font-medium border-border hover:bg-secondary"
                onClick={() => {
                  setShowLoginModal(false);
                  window.open('https://www.aaltoes.com/get-involved', '_blank');
                }}
              >
                Get involved
              </Button>
              <Button
                variant="default"
                className="h-10 px-5 text-sm font-medium"
                onClick={() => {
                  setShowLoginModal(false);
                  signIn('google');
                }}
              >
                Login
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Availability Dialog */}
      <Dialog open={showAvailabilityModal} onOpenChange={setShowAvailabilityModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-center font-mono">BLUEPRINT</DialogTitle>
          </DialogHeader>
          <div className="text-center py-6">
            <div className="mb-6">
              {availabilityType === 'public' ? (
                <>
                  <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                    Public version is not available yet, we work hard to filter our files for you.
                    You can request access to private version at{' '}
                    <a 
                      href="mailto:board@aaltoes.com" 
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                    >
                      board@aaltoes.com
                    </a>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                    Something went wrong and private documents are not available.
                  </p>
                  <p className="text-muted-foreground text-sm">
                    You can report issues at{' '}
                    <a 
                      href="mailto:board@aaltoes.com" 
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                    >
                      board@aaltoes.com
                    </a>
                  </p>
                </>
              )}
            </div>
            <div className="flex justify-center">
              <Button
                variant="default"
                className="h-auto px-4 py-2 text-sm font-mono dark:bg-white dark:text-black dark:hover:bg-gray-100"
                onClick={() => {
                  setShowAvailabilityModal(false);
                  const subject = availabilityType === 'public' 
                    ? encodeURIComponent('Blueprint - Request for private access')
                    : encodeURIComponent('Blueprint - Report an issue');
                  const body = encodeURIComponent('Hei! I think that ');
                  window.open(`mailto:board@aaltoes.com?subject=${subject}&body=${body}`, '_blank');
                }}
              >
                Contact Us
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Search Input - Fixed at bottom */}
      <div className="bg-background pt-4 pb-8 lg:pb-12">
        <div className="max-w-6xl mx-auto px-4 lg:px-6">
          <Card className="border-border/50 shadow-sm">
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 relative">
                  <Textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!isSearching && !isStreaming) {
                          handleSearch();
                        }
                      }
                    }}
                    placeholder="Ask about Aaltoes board decisions, budgets, or projects..."
                    rows={1}
                    className="resize-none text-lg min-h-[52px] py-3 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-foreground/40"
                  />
                </div>
                {isSearching || isStreaming ? (
                  <Button
                    onClick={handleStop}
                    variant="destructive"
                    className="h-10 w-10 p-0 rounded-full flex-shrink-0"
                    size="sm"
                  >
                    {isSearching && !isStreaming ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Square className="w-4 h-4 fill-current" />
                    )}
                  </Button>
                ) : question.trim() ? (
                  <span className="text-xs text-foreground/40 flex-shrink-0 px-2">Press Enter ↵</span>
                ) : null}
              </div>

              {/* Filters row */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/30 flex-wrap">
                
                {/* Year buttons */}
                {availableYears.map((year) => (
                  <button
                    key={year}
                    className={`text-xs h-7 px-2.5 rounded-full font-medium transition-colors ${
                      selectedYears.includes(year)
                        ? 'bg-foreground/10 text-foreground'
                        : 'text-foreground/50 hover:text-foreground hover:bg-secondary'
                    }`}
                    onClick={() => toggleYear(year)}
                  >
                    {year}
                  </button>
                ))}

                {selectedYears.length > 0 && (
                  <button
                    onClick={() => setSelectedYears([])}
                    className="h-7 w-7 p-0 flex items-center justify-center text-foreground/40 hover:text-foreground rounded-full hover:bg-secondary"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}

                <div className="h-4 w-px bg-border mx-1" />

                {/* Data type dropdown */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-xs h-7 px-2.5 rounded-full font-medium text-foreground/50 hover:text-foreground hover:bg-secondary flex items-center gap-1">
                      {selectedDataTypes.length === 0 ? 'All types' : `${selectedDataTypes.length} type${selectedDataTypes.length > 1 ? 's' : ''}`}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[160px] p-1" align="start" side="top">
                    {availableDataTypes.filter(dt => dt.value !== 'all').map((dataType) => (
                      <button
                        key={dataType.value}
                        onClick={() => {
                          setSelectedDataTypes(prev =>
                            prev.includes(dataType.value)
                              ? prev.filter(t => t !== dataType.value)
                              : [...prev, dataType.value]
                          );
                        }}
                        className="w-full text-left text-sm py-2 px-2.5 rounded hover:bg-secondary flex items-center justify-between"
                      >
                        <span>{dataType.label}</span>
                        {selectedDataTypes.includes(dataType.value) && (
                          <Check className="h-4 w-4" />
                        )}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>

                <div className="h-4 w-px bg-border mx-1" />

                {/* Top-k dropdown */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-xs h-7 px-2.5 rounded-full font-medium text-foreground/50 hover:text-foreground hover:bg-secondary flex items-center gap-1">
                      Top {topK}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[90px] p-1" align="start" side="top">
                    {topKOptions.map((k) => (
                      <button
                        key={k}
                        onClick={() => updateTopK(k)}
                        className={`w-full text-left text-sm py-2 px-2.5 rounded hover:bg-secondary ${topK === k ? 'bg-secondary' : ''}`}
                      >
                        {k}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}