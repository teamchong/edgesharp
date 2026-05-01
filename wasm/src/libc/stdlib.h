#ifndef _STDLIB_H
#define _STDLIB_H
#include <stddef.h>
void *malloc(size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
void *calloc(size_t nmemb, size_t size);
int abs(int x);
void qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *));
void *bsearch(const void *key, const void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *));
#define EXIT_FAILURE 1
#define EXIT_SUCCESS 0
#endif
