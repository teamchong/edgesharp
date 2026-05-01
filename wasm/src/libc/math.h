#ifndef _MATH_H
#define _MATH_H

double log(double x);
double log2(double x);
double pow(double x, double y);
double sqrt(double x);
double floor(double x);
double ceil(double x);
double fabs(double x);
double exp(double x);
double round(double x);
double log10(double x);
float logf(float x);
float log2f(float x);
float powf(float x, float y);
float sqrtf(float x);
float floorf(float x);
float ceilf(float x);
float fabsf(float x);
float expf(float x);
float roundf(float x);

#define INFINITY __builtin_inf()
#define NAN __builtin_nan("")
#define HUGE_VAL __builtin_huge_val()

#endif
