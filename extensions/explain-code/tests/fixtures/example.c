int total(const int *values, int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
        sum += values[index];
    }
    return sum;
}
